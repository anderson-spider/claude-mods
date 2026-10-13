// Starting or reusing a team agent in Herdr and handing it a task, over an injected command runner. Pure: no host access.
// After herdr-router (github.com/Qingswe/herdr-router, used with its author's permission): delivery is `confirmed`,
// `unknown` or `not_sent`, and a prompt is never sent twice.

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Run = (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<RunResult>

/** `confirmed`: the agent started working on it; `not_sent`: it never reached the agent; `unknown`: it may have. */
export type PromptStatus = 'confirmed' | 'unknown' | 'not_sent'

export type Listed = { name?: string; pane_id: string; cwd?: string; agent_status?: string }

export type Delivery = {
  agent: string
  pane?: string
  /** Whether this call started the agent (and its pane). */
  started: boolean
  status: PromptStatus
  /** Why it was not confirmed: a Herdr error code or a short reason; never the prompt. */
  reason?: string
}

export type DispatchInput = {
  name: string
  /** The developer's rule: no other developer may work in the same directory. */
  writes: boolean
  workspace: string
  cwd: string
  codexArgs: readonly string[]
  prompt: string
  /** Called once the prompt is about to be written: the caller records `unknown` before anything can reach the agent. */
  beforeSend?: () => Promise<void>
}

/** Herdr refuses a prompt above this; the router does the same. */
export const MAX_PROMPT_BYTES = 64 * 1024

const START_TIMEOUT_MS = 60_000
const PROMPT_TIMEOUT_MS = 15_000

/** The team's agent names: the reusable roles and every `dev-<slug>`. */
export const isTeamName = (name: string | undefined): boolean => name === 'analyst' || name === 'architect' || /^dev-/.test(name ?? '')

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

export async function listAgents(run: Run): Promise<Listed[] | string> {
  const done = await run(['herdr', 'agent', 'list'])
  if (done.exitCode !== 0) return errorOf(done)
  const agents = at(json(done.stdout), 'result', 'agents')
  return Array.isArray(agents) ? (agents as Listed[]) : 'agent list unreadable'
}

/** A pane for a new team agent: split beside a live team agent's pane, or a new tab when the team has none. */
async function newPane(run: Run, input: DispatchInput, team: readonly Listed[]): Promise<string | { reason: string }> {
  const anchor = team[0]?.pane_id
  const done = anchor
    ? await run(['herdr', 'pane', 'split', '--pane', anchor, '--direction', 'right', '--cwd', input.cwd, '--no-focus'])
    : await run(['herdr', 'tab', 'create', '--workspace', input.workspace, '--cwd', input.cwd, '--label', 'codex team', '--no-focus'])
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
  const base = { agent: input.name, started: false }
  if (new TextEncoder().encode(input.prompt).length > MAX_PROMPT_BYTES) return { ...base, status: 'not_sent', reason: 'prompt over 64 KiB' }

  const agents = await listAgents(run)
  if (typeof agents === 'string') return { ...base, status: 'not_sent', reason: agents }
  const live = agents.find(agent => agent.name === input.name)

  if (input.writes) {
    const other = agents.find(agent => agent.name !== input.name && isTeamName(agent.name) && agent.name?.startsWith('dev-') && normal(agent.cwd) === normal(input.cwd))
    if (other) return { ...base, status: 'not_sent', reason: `${other.name} already works in this directory` }
    if (live && normal(live.cwd) !== normal(input.cwd)) return { ...base, pane: live.pane_id, status: 'not_sent', reason: `${input.name} works in another directory` }
  }

  let pane = live?.pane_id
  let started = false
  if (live) {
    if (live.agent_status === 'working') return { ...base, pane, status: 'not_sent', reason: 'agent busy' }
    if (live.agent_status === 'blocked') return { ...base, pane, status: 'not_sent', reason: 'agent blocked' }
  } else {
    const made = await newPane(run, input, agents.filter(agent => isTeamName(agent.name)))
    if (typeof made !== 'string') return { ...base, status: 'not_sent', reason: made.reason }
    pane = made
    const start = await run(['herdr', 'agent', 'start', input.name, '--kind', 'codex', '--pane', made, '--timeout', String(START_TIMEOUT_MS), '--', ...input.codexArgs], { timeoutMs: START_TIMEOUT_MS + 10_000 })
    if (start.exitCode !== 0) return { ...base, pane, started: false, status: 'not_sent', reason: errorOf(start) }
    started = true
  }

  await input.beforeSend?.()
  const sent = await run(
    ['herdr', 'agent', 'prompt', input.name, input.prompt, '--wait', '--until', 'working', '--until', 'blocked', '--timeout', String(PROMPT_TIMEOUT_MS)],
    { timeoutMs: PROMPT_TIMEOUT_MS + 10_000 },
  ).catch(() => undefined)
  if (!sent) return { agent: input.name, pane, started, status: 'unknown', reason: 'prompt call failed' }
  if (sent.exitCode === 0) return { agent: input.name, pane, started, status: 'confirmed' }
  const reason = errorOf(sent)
  // Refused before any byte was written: the agent never saw it.
  const refused = reason === 'agent_blocked' || reason === 'agent_not_found'
  return { agent: input.name, pane, started, status: refused ? 'not_sent' : 'unknown', reason }
}
