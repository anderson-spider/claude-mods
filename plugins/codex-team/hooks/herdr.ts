// Starting or reusing a team agent in Herdr and handing it a task, over an injected command runner. Pure: no host access.
// After herdr-router (github.com/Qingswe/herdr-router, used with its author's permission): delivery is `confirmed`,
// `unknown` or `not_sent`, and a prompt is never sent twice.
import { effectiveName, logicalName, taskSlug } from './names'
export { isTeamName } from './names'

export type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }
export type Run = (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<RunResult>

/** `confirmed`: the agent started working on it; `not_sent`: it never reached the agent; `unknown`: it may have. */
export type PromptStatus = 'confirmed' | 'unknown' | 'not_sent'

export type Listed = { name?: string; workspace_id: string; pane_id: string; cwd?: string; agent_status?: string }

export type Delivery = {
  agent: string
  effectiveAgent: string
  pane?: string
  /** Whether this call started the agent (and its pane). */
  started: boolean
  /** Whether the target was already live in the agent list, including refused dispatches. */
  existed: boolean
  status: PromptStatus
  /** Why it was not confirmed: a Herdr error code or a short reason; never the prompt. */
  reason?: string
}

export type DispatchInput = {
  name: string
  slug: string
  /** The developer's rule: no other developer may work in the same directory. */
  writes: boolean
  workspace: string
  cwd: string
  codexArgs: readonly string[]
  prompt: string
  /** Called before writing the prompt, with whether this call started the agent, so its `unknown` record is accurate. */
  beforeSend?: (started: boolean, name: string) => Promise<void>
  /** An analyst uses its task-specific name when the shared analyst is busy. */
  analystSlug?: string
  /** Recheck on the delivery listing before any pane, startup or prompt effect. */
  reviewDeveloper?: string
  /** Dispatch retires an idle/done shared role before starting a fresh session. */
  finishShared?: (name: string) => Promise<{ closed: boolean; archived: boolean; reason?: string }>
}

/** Herdr refuses a prompt above this; the router does the same. */
export const MAX_PROMPT_BYTES = 64 * 1024

const START_TIMEOUT_MS = 60_000
const PROMPT_TIMEOUT_MS = 15_000

const normal = (path: string | undefined) => (path ?? '').replace(/\/+$/, '')

function json(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The error code Herdr printed as `{"error":{"code":...}}`, or a short reason without the output's text. */
export function errorOf(done: RunResult): string {
  const code = (json(done.stderr)?.error as { code?: unknown } | undefined)?.code ?? (json(done.stdout)?.error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : `exit ${done.exitCode}`
}

const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), value)

export async function listAgents(run: Run, init?: { timeoutMs?: number }): Promise<Listed[] | string> {
  const done = await run(['herdr', 'agent', 'list'], init)
  if (done.exitCode !== 0) return errorOf(done)
  const agents = at(json(done.stdout), 'result', 'agents')
  return !done.isStdoutTruncated && Array.isArray(agents) && agents.every(agent => agent && typeof agent.workspace_id === 'string' && typeof agent.pane_id === 'string' && (agent.name === undefined || typeof agent.name === 'string'))
    ? (agents as Listed[]) : 'agent list unreadable'
}

/** Task peers share a tab; one-shot shared roles get a fresh current task tab without label state. */
async function newPane(run: Run, input: DispatchInput, team: readonly Listed[]): Promise<string | { reason: string }> {
  const slug = taskSlug(input.name)
  const anchor = slug === undefined ? undefined : team.find(agent => agent.workspace_id === input.workspace
    && taskSlug(logicalName(agent.name, input.workspace)) === slug)?.pane_id
  const done = anchor
    ? await run(['herdr', 'pane', 'split', '--pane', anchor, '--direction', 'right', '--cwd', input.cwd, '--no-focus'])
    : await run(['herdr', 'tab', 'create', '--workspace', input.workspace, '--cwd', input.cwd, '--label', `codex - ${slug ?? input.slug}`, '--no-focus'])
  if (done.exitCode !== 0) return { reason: errorOf(done) }
  const pane = anchor ? at(json(done.stdout), 'result', 'pane', 'pane_id') : at(json(done.stdout), 'result', 'root_pane', 'pane_id')
  return typeof pane === 'string' ? pane : { reason: 'no pane id in the answer' }
}

/**
 * Hands `prompt` to the named agent, starting it first when it is not live. A busy or blocked agent, another developer
 * in the same directory, a failed start or a refused prompt is `not_sent`; a prompt that may have reached the agent but
 * was not seen starting is `unknown`, and is never sent again.
 */
export async function deliver(run: Run, input: DispatchInput): Promise<Delivery> {
  let name = effectiveName(input.name, input.workspace)
  let base = { agent: input.name, effectiveAgent: name ?? '', started: false, existed: false }
  if (!name) return { ...base, status: 'not_sent', reason: 'workspace id or team name cannot fit a Herdr name' }
  if (new TextEncoder().encode(input.prompt).length > MAX_PROMPT_BYTES) return { ...base, status: 'not_sent', reason: 'prompt over 64 KiB' }

  let agents = await listAgents(run)
  if (typeof agents === 'string') return { ...base, status: 'not_sent', reason: agents }
  const collision = (listed: readonly Listed[]) => listed.some(agent => agent.name === name && agent.workspace_id !== input.workspace)
  if (collision(agents)) {
    return { ...base, existed: true, status: 'not_sent', reason: `${input.name} is live in another workspace` }
  }
  const shared = agents.find(agent => agent.name === name && agent.workspace_id === input.workspace)
  if (input.name === 'analyst' && input.analystSlug && ['working', 'blocked'].includes(shared?.agent_status ?? '')) {
    input = { ...input, name: `analyst-${input.analystSlug}` }
    name = effectiveName(input.name, input.workspace)!
    base = { ...base, agent: input.name, effectiveAgent: name }
  }
  if ((input.name === 'analyst' || input.name === 'architect') && shared && ['idle', 'done'].includes(shared.agent_status ?? '')) {
    if (!input.finishShared) return { ...base, existed: true, status: 'not_sent', reason: 'shared agent finish unavailable' }
    const finished = await input.finishShared(input.name)
    if (!finished.closed || !finished.archived) return { ...base, existed: true, status: 'not_sent', reason: `shared agent finish failed (${finished.reason ?? 'not archived'})` }
    agents = await listAgents(run)
    if (typeof agents === 'string') return { ...base, status: 'not_sent', reason: agents }
    if (agents.some(agent => agent.name === name)) return { ...base, existed: true, status: 'not_sent', reason: 'shared agent reappeared after finish' }
  }
  const live = agents.find(agent => agent.name === name && agent.workspace_id === input.workspace)
  base.existed = live !== undefined
  if (collision(agents)) {
    return { ...base, existed: true, status: 'not_sent', reason: `${input.name} is live in another workspace` }
  }
  const developer = input.reviewDeveloper && agents.find(agent => agent.workspace_id === input.workspace && agent.name === effectiveName(input.reviewDeveloper!, input.workspace))
  if (developer && ['working', 'blocked'].includes(developer.agent_status ?? '')) {
    return { ...base, status: 'not_sent', reason: `${input.reviewDeveloper} is ${developer.agent_status}` }
  }

  if (input.writes) {
    const other = agents.find(agent => agent.workspace_id === input.workspace && agent.name !== name && logicalName(agent.name, input.workspace)?.startsWith('dev-') && normal(agent.cwd) === normal(input.cwd))
    if (other) return { ...base, status: 'not_sent', reason: `${logicalName(other.name, input.workspace)} already works in this directory` }
    if (live && normal(live.cwd) !== normal(input.cwd)) return { ...base, pane: live.pane_id, status: 'not_sent', reason: `${input.name} works in another directory` }
  }

  let pane = live?.pane_id
  let started = false
  if (live) {
    if (live.agent_status === 'working') return { ...base, pane, status: 'not_sent', reason: 'agent busy' }
    if (live.agent_status === 'blocked') return { ...base, pane, status: 'not_sent', reason: 'agent blocked' }
  } else {
    const made = await newPane(run, input, agents.filter(agent => agent.workspace_id === input.workspace && logicalName(agent.name, input.workspace) !== undefined))
    if (typeof made !== 'string') return { ...base, status: 'not_sent', reason: made.reason }
    pane = made
    const start = await run(['herdr', 'agent', 'start', name, '--kind', 'codex', '--pane', made, '--timeout', String(START_TIMEOUT_MS), '--', ...input.codexArgs], { timeoutMs: START_TIMEOUT_MS + 10_000 })
    if (start.exitCode !== 0) return { ...base, pane, started: false, status: 'not_sent', reason: errorOf(start) }
    started = true
  }

  await input.beforeSend?.(started, input.name)
  const sent = await run(
    ['herdr', 'agent', 'prompt', name, input.prompt, '--wait', '--until', 'working', '--until', 'blocked', '--timeout', String(PROMPT_TIMEOUT_MS)],
    { timeoutMs: PROMPT_TIMEOUT_MS + 10_000 },
  ).catch(() => undefined)
  if (!sent) return { ...base, pane, started, status: 'unknown', reason: 'prompt call failed' }
  if (sent.exitCode === 0) return { ...base, pane, started, status: 'confirmed' }
  const reason = errorOf(sent)
  // Refused before any byte was written: the agent never saw it.
  const refused = reason === 'agent_blocked' || reason === 'agent_not_found'
  return { ...base, pane, started, status: refused ? 'not_sent' : 'unknown', reason }
}
