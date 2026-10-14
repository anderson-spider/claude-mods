// Starting a fresh team agent in Herdr and handing it a task, over an injected command runner. Pure: no host access.
// After herdr-router (github.com/Qingswe/herdr-router, used with its author's permission): delivery is `confirmed`,
// `unknown` or `not_sent`, and a prompt is never sent twice.
import { effectiveName, logicalName, taskSlug } from './names'
export { isTeamName } from './names'

export type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }
export type Run = (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<RunResult>

/** `confirmed`: the agent started working on it; `not_sent`: it never reached the agent; `unknown`: it may have. */
export type PromptStatus = 'confirmed' | 'unknown' | 'not_sent'

export type Listed = { name?: string; workspace_id: string; pane_id: string; cwd?: string; agent_status?: string; agent?: string; agent_session?: { kind?: string; source?: string; value?: string } }

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
  /** Resolve startup flags only for a new session, after all guards and previous-agent retirement. */
  startArgs: (name: string) => Promise<readonly string[] | { refusal: string }>
  prompt: string
  /** Called before writing the prompt, with whether this call started the agent, so its `unknown` record is accurate. */
  beforeSend?: (started: boolean, name: string, pane: string) => Promise<void>
  /** An analyst uses its task-specific name when the shared analyst is busy. */
  analystSlug?: string
  architectSlug?: string
  sleep?: (ms: number) => Promise<void>
  now?: () => Promise<number>
  rollbackPane?: (pane: string, terminal: string, name: string) => Promise<void>
  /** Recheck on the delivery listing before any pane, startup or prompt effect. */
  reviewDeveloper?: string
  /** Dispatch retires the previous idle/done agent before starting a fresh session. */
  finishPrevious?: (name: string) => Promise<{ closed: boolean; archived: boolean; reason?: string }>
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
  return !done.isStdoutTruncated && Array.isArray(agents) && agents.every(agent => agent && typeof agent.workspace_id === 'string' && typeof agent.pane_id === 'string' && (agent.name == null || typeof agent.name === 'string'))
    ? agents.map(agent => ({ ...agent, name: agent.name ?? undefined })) as Listed[] : 'agent list unreadable'
}

/** Task peers share a tab; one-shot shared roles get a fresh current task tab without label state. */
async function newPane(run: Run, input: DispatchInput, team: readonly Listed[]): Promise<{ pane: string; terminal?: string } | { reason: string }> {
  const slug = taskSlug(input.name)
  const anchor = slug === undefined ? undefined : team.find(agent => agent.workspace_id === input.workspace
    && taskSlug(logicalName(agent.name, input.workspace)) === slug)?.pane_id
  const done = anchor
    ? await run(['herdr', 'pane', 'split', '--pane', anchor, '--direction', 'right', '--cwd', input.cwd, '--no-focus'])
    : await run(['herdr', 'tab', 'create', '--workspace', input.workspace, '--cwd', input.cwd, '--label', `codex - ${slug ?? input.slug}`, '--no-focus'])
  if (done.exitCode !== 0) return { reason: errorOf(done) }
  const created = at(json(done.stdout), 'result', anchor ? 'pane' : 'root_pane')
  const pane = at(created, 'pane_id'), terminal = at(created, 'terminal_id')
  return !done.isStdoutTruncated && typeof pane === 'string' && pane ? { pane, terminal: typeof terminal === 'string' ? terminal : undefined } : { reason: 'no pane id in the answer' }
}

/** Retry only a shell-busy refusal, retaining the newly created terminal and the selected flags. */
export async function startWhenShellReady(run: Run, argv: readonly string[], input: DispatchInput, pane: string, terminal?: string): Promise<RunResult> {
  const startedAt = await input.now?.()
  let slept = 0
  while (true) {
    const result = await run(argv, { timeoutMs: START_TIMEOUT_MS + 10_000 })
    if (result.exitCode === 0 || result.isStdoutTruncated || result.isStderrTruncated || errorOf(result) !== 'agent_pane_busy' || !terminal || !input.sleep || !input.now || startedAt === undefined) return result
    if (slept >= 5_000 || await input.now() - startedAt >= 5_000) return result
    await input.sleep(250)
    slept += 250
    const got = await run(['herdr', 'pane', 'get', pane], { timeoutMs: 2_000 })
    const live = at(json(got.stdout), 'result', 'pane')
    if (got.exitCode !== 0 || got.isStdoutTruncated || at(live, 'pane_id') !== pane || at(live, 'workspace_id') !== input.workspace
      || at(live, 'terminal_id') !== terminal || at(live, 'agent') || at(live, 'agent_session')) return { exitCode: 1, stderr: '', stdout: '' }
    const agents = await listAgents(run, { timeoutMs: 2_000 })
    if (typeof agents === 'string' || agents.some(agent => agent.workspace_id === input.workspace && agent.pane_id === pane)
      || await input.now() - startedAt >= 5_000) return result
  }
}

/** `dev-x (model/effort)` from the start argv's `-m` and `model_reasoning_effort`. */
export function paneLabel(name: string, args: readonly string[]): string {
  const model = args[args.indexOf('-m') + 1]
  const effort = args.map(a => /^model_reasoning_effort="?([^"]*)"?$/.exec(a)?.[1]).find(Boolean)
  return model && args.includes('-m') && effort ? `${name} (${model}/${effort})` : name
}

/**
 * Hands `prompt` to the named agent, retiring its settled predecessor and starting a fresh session. A busy or blocked agent, another developer
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
  const fallbackSlug = input.name === 'analyst' ? input.analystSlug : input.name === 'architect' ? input.architectSlug : undefined
  if (fallbackSlug && ['working', 'blocked'].includes(shared?.agent_status ?? '')) {
    input = { ...input, name: `${input.name}-${fallbackSlug}` }
    name = effectiveName(input.name, input.workspace)!
    base = { ...base, agent: input.name, effectiveAgent: name }
  }
  // Check both before retirement and after its fresh listing: a reviewer or writer may become busy meanwhile.
  const guard = (listed: Listed[]): Delivery | undefined => {
    const live = listed.find(agent => agent.name === name && agent.workspace_id === input.workspace)
    base.existed = live !== undefined
    if (collision(listed)) return { ...base, existed: true, status: 'not_sent', reason: `${input.name} is live in another workspace` }
    const developer = input.reviewDeveloper && listed.find(agent => agent.workspace_id === input.workspace && agent.name === effectiveName(input.reviewDeveloper!, input.workspace))
    if (developer && ['working', 'blocked'].includes(developer.agent_status ?? '')) return { ...base, status: 'not_sent', reason: `${input.reviewDeveloper} is ${developer.agent_status}` }
    if (input.writes) {
      const other = listed.find(agent => agent.workspace_id === input.workspace && agent.name !== name && logicalName(agent.name, input.workspace)?.startsWith('dev-') && normal(agent.cwd) === normal(input.cwd))
      if (other) return { ...base, status: 'not_sent', reason: `${logicalName(other.name, input.workspace)} already works in this directory` }
      if (live && normal(live.cwd) !== normal(input.cwd)) return { ...base, pane: live.pane_id, status: 'not_sent', reason: `${input.name} works in another directory` }
    }
    if (live && !['idle', 'done'].includes(live.agent_status ?? '')) return { ...base, pane: live.pane_id, status: 'not_sent', reason: live.agent_status === 'working' ? 'agent busy' : live.agent_status === 'blocked' ? 'agent blocked' : 'agent state is not idle or done' }
  }
  const guarded = guard(agents)
  if (guarded) return guarded
  if (agents.some(agent => agent.name === name && agent.workspace_id === input.workspace)) {
    if (!input.finishPrevious) return { ...base, status: 'not_sent', reason: 'agent finish unavailable' }
    const finished = await input.finishPrevious(input.name)
    if (!finished.closed || !finished.archived) return { ...base, status: 'not_sent', reason: `agent finish failed (${finished.reason ?? 'not archived'})` }
    agents = await listAgents(run)
    if (typeof agents === 'string') return { ...base, status: 'not_sent', reason: agents }
    if (agents.some(agent => agent.name === name)) return { ...base, status: 'not_sent', reason: 'agent reappeared after finish' }
    const changed = guard(agents)
    if (changed) return changed
  }
  const args = await input.startArgs(input.name)
  if ('refusal' in args) return { ...base, status: 'not_sent', reason: args.refusal }
  const made = await newPane(run, input, agents.filter(agent => agent.workspace_id === input.workspace && logicalName(agent.name, input.workspace) !== undefined))
  if ('reason' in made) return { ...base, status: 'not_sent', reason: made.reason }
  const { pane, terminal } = made
  let start: RunResult
  try {
    start = await startWhenShellReady(run, ['herdr', 'agent', 'start', name, '--kind', 'codex', '--pane', pane, '--timeout', String(START_TIMEOUT_MS), '--', ...args], input, pane, terminal)
  } catch { start = { exitCode: 1, stdout: '', stderr: '' } }
  if (start.exitCode !== 0) {
    if (terminal) await input.rollbackPane?.(pane, terminal, input.name).catch(() => undefined)
    return { ...base, pane, started: false, status: 'not_sent', reason: errorOf(start) }
  }
  const started = true
  // Display only: the pane shows the logical name and the started pair; a refused rename changes nothing.
  await run(['herdr', 'pane', 'rename', pane, paneLabel(input.name, args)]).catch(() => undefined)

  await input.beforeSend?.(started, input.name, pane)
  const sent = await run(
    ['herdr', 'agent', 'prompt', name, input.prompt, '--wait', '--until', 'working', '--until', 'blocked', '--timeout', String(PROMPT_TIMEOUT_MS)],
    { timeoutMs: PROMPT_TIMEOUT_MS + 10_000 },
  ).catch(() => undefined)
  if (!sent) return { ...base, pane, started, status: 'unknown', reason: 'prompt call failed' }
  if (sent.exitCode === 0) return { ...base, pane, started, status: 'confirmed' }
  const reason = errorOf(sent)
  // Refused before any byte was written: the agent never saw it.
  const refused = reason === 'agent_blocked' || reason === 'agent_not_found'
  if (refused && terminal) await input.rollbackPane?.(pane, terminal, input.name).catch(() => undefined)
  return { ...base, pane, started, status: refused ? 'not_sent' : 'unknown', reason }
}
