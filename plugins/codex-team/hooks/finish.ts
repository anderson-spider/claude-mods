// Finish a settled team agent through injected I/O. The process must exit before Codex archives its thread.
import { errorOf, isTeamName, listAgents } from './herdr'
import { effectiveName, taskSlug } from './names'
import { SLUG } from './roles'
import type { Listed, Run } from './herdr'
import { codexUuid } from './auto-close'

export type Finish = { agent: string; effectiveAgent: string; uuid: string | null; pane?: string; tab?: string; closed: boolean; archived: boolean; reason?: string }
export type FinishGuard = { expected?: { pane: string; uuid: string }; current?: () => boolean }
type Input = { agent: string; workspace: string; leadPane: string | undefined } & FinishGuard
type Agent = Listed & { tab_id?: string; agent?: string; agent_session?: { kind?: string; source?: string; value?: string } }

function result(text: string): Record<string, unknown> | undefined {
  try { return JSON.parse(text)?.result } catch { return undefined }
}

/** Refuse before mutation on uncertain identity, state or ownership; all errors discard command output. */
export async function finishAgent(run: Run, sleep: (ms: number) => Promise<void>, input: Input): Promise<Finish> {
  const name = effectiveName(input.agent, input.workspace)
  const finished: Finish = { agent: input.agent, effectiveAgent: name ?? '', uuid: null, closed: false, archived: false }
  const refuse = (reason: string): Finish => ({ ...finished, reason })
  if (!isTeamName(input.agent)) return refuse('agent must be a Codex team name')
  if (!name) return refuse('workspace id cannot fit a Herdr name')
  if (!input.leadPane) return refuse('HERDR_PANE_ID is not set')
  if (input.current && !input.current()) return refuse('expected agent changed')
  const got = await run(['herdr', 'agent', 'get', name], { timeoutMs: 2_000 }).catch(() => undefined)
  if (!got) return refuse('agent get failed')
  if (got.exitCode !== 0) return refuse(errorOf(got))
  const agent = result(got.stdout)?.agent as Agent | undefined
  if (got.isStdoutTruncated || !agent || agent.name !== name || typeof agent.pane_id !== 'string' || !agent.pane_id) return refuse('agent identity unreadable')
  if (agent.workspace_id !== input.workspace) return refuse('agent is live in another workspace')
  if (!['idle', 'done'].includes(agent.agent_status ?? '')) return refuse(`agent ${agent.agent_status === 'working' ? 'busy' : agent.agent_status === 'blocked' ? 'blocked' : 'state is not idle or done'}`)
  if (agent.pane_id === input.leadPane) return refuse('cannot close the lead pane')
  const session = agent.agent_session
  if (agent.agent !== 'codex' || session?.kind !== 'id' || session.source !== 'herdr:codex' || typeof session.value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.value)) return refuse('Codex session uuid unavailable')
  if (input.expected && (input.expected.pane !== agent.pane_id || input.expected.uuid !== session.value)) return refuse('expected agent changed')
  finished.uuid = session.value
  finished.pane = agent.pane_id

  // Herdr removes a tab when its last pane closes; never issue a broader tab-close command.
  if (agent.tab_id) {
    const tabs = await run(['herdr', 'tab', 'list', '--workspace', input.workspace], { timeoutMs: 2_000 }).catch(() => undefined)
    if (!tabs || tabs.exitCode !== 0) return refuse(tabs ? errorOf(tabs) : 'tab list failed')
    const listed = result(tabs.stdout)?.tabs
    if (tabs.isStdoutTruncated || !Array.isArray(listed)) return refuse('tab list unreadable')
    const tab = listed.find(tab => tab?.tab_id === agent.tab_id && tab.workspace_id === input.workspace)
    const slug = taskSlug(input.agent)
    const sharedSlug = typeof tab?.label === 'string' && tab.label.startsWith('codex - ')
      ? tab.label.slice('codex - '.length) : undefined
    if (tab?.pane_count === 1 && (slug ? tab.label === `codex - ${slug}` : sharedSlug && SLUG.test(sharedSlug))) finished.tab = agent.tab_id
  }

  // Check the exact name/pane pair again after metadata reads, immediately before closing.
  const agents = await listAgents(run, { timeoutMs: 2_000 }).catch(() => 'agent list failed')
  if (typeof agents === 'string') return refuse(agents)
  const local = agents.filter(live => live.workspace_id === input.workspace)
  if (agents.some(live => live.name === name && live.workspace_id !== input.workspace)) return refuse('agent is live in another workspace')
  const live = local.find(live => live.name === name)
  if (!live || live.pane_id !== agent.pane_id || live.workspace_id !== input.workspace || local.some(other => other.pane_id === agent.pane_id && other.name !== name)) return refuse('pane no longer hosts that agent')
  if (!['idle', 'done'].includes(live.agent_status ?? '')) return refuse('agent is no longer idle or done')
  if (codexUuid(live) !== session.value || (input.current && !input.current())) return refuse('expected agent changed')
  const closed = await closePane(run, agent.pane_id)
  if (!closed || closed.exitCode !== 0) return refuse(closed ? errorOf(closed) : 'pane close failed')
  finished.closed = true
  for (let poll = 0; poll < 10; poll++) {
    const remaining = await listAgents(run, { timeoutMs: 2_000 }).catch(() => 'agent list failed')
    if (typeof remaining === 'string') return refuse(remaining)
    if (!remaining.some(live => live.workspace_id === input.workspace && (live.name === name || live.pane_id === agent.pane_id))) {
      const archived = await run(['codex', 'archive', session.value], { timeoutMs: 15_000 }).catch(() => undefined)
      if (!archived || archived.exitCode !== 0) return refuse(archived ? `archive exit ${archived.exitCode}` : 'archive call failed')
      return { ...finished, archived: true }
    }
    if (poll < 9) await sleep(250)
  }
  return refuse('agent exit timed out; archive not attempted')
}

const closePane = (run: Run, pane: string) => run(['herdr', 'pane', 'close', pane], { timeoutMs: 2_000 }).catch(() => undefined)

/** Roll back only the empty terminal created by this dispatch; tabs disappear with their last pane. */
export async function finishEmptyPane(run: Run, input: Input & { pane: string; terminal: string }): Promise<Finish> {
  const base: Finish = { agent: input.agent, effectiveAgent: effectiveName(input.agent, input.workspace) ?? '', uuid: null, closed: false, archived: false }
  const refused = (): Finish => ({ ...base, reason: 'startup pane cleanup refused' })
  if (!base.effectiveAgent || !input.leadPane || input.pane === input.leadPane) return refused()
  const empty = async () => {
    const got = await run(['herdr', 'pane', 'get', input.pane], { timeoutMs: 2_000 })
    const pane = result(got.stdout)?.pane as { pane_id?: string; workspace_id?: string; terminal_id?: string; agent?: unknown; agent_session?: unknown } | undefined
    return got.exitCode === 0 && !got.isStdoutTruncated && pane?.pane_id === input.pane && pane.workspace_id === input.workspace
      && pane.terminal_id === input.terminal && !pane.agent && !pane.agent_session
  }
  try {
    if (!await empty()) return refused()
    const agents = await listAgents(run, { timeoutMs: 2_000 })
    if (typeof agents === 'string' || agents.some(agent => agent.workspace_id === input.workspace && agent.pane_id === input.pane) || !await empty()) return refused()
    const closed = await closePane(run, input.pane)
    return closed?.exitCode === 0 ? { ...base, pane: input.pane, closed: true } : { ...base, reason: 'startup pane cleanup failed' }
  } catch { return { ...base, reason: 'startup pane cleanup failed' } }
}
