// Finish a settled team agent through injected I/O. The process must exit before Codex archives its thread.
import { errorOf, isTeamName, listAgents } from './herdr'
import type { Listed, Run } from './herdr'

export type Finish = { agent: string; uuid: string | null; pane?: string; tab?: string; closed: boolean; archived: boolean; reason?: string }
type Input = { agent: string; workspace: string; leadPane: string | undefined }
type Agent = Listed & { tab_id?: string; agent?: string; agent_session?: { kind?: string; source?: string; value?: string } }

function result(text: string): Record<string, unknown> | undefined {
  try { return JSON.parse(text)?.result } catch { return undefined }
}

/** Refuse before mutation on uncertain identity, state or ownership; all errors discard command output. */
export async function finishAgent(run: Run, sleep: (ms: number) => Promise<void>, input: Input): Promise<Finish> {
  const finished: Finish = { agent: input.agent, uuid: null, closed: false, archived: false }
  const refuse = (reason: string): Finish => ({ ...finished, reason })
  if (!isTeamName(input.agent)) return refuse('agent must be a Codex team name')
  if (!input.leadPane) return refuse('HERDR_PANE_ID is not set')
  const got = await run(['herdr', 'agent', 'get', input.agent], { timeoutMs: 2_000 }).catch(() => undefined)
  if (!got) return refuse('agent get failed')
  if (got.exitCode !== 0) return refuse(errorOf(got))
  const agent = result(got.stdout)?.agent as Agent | undefined
  if (got.isStdoutTruncated || !agent || agent.name !== input.agent || typeof agent.pane_id !== 'string' || !agent.pane_id) return refuse('agent identity unreadable')
  if (agent.workspace_id !== input.workspace) return refuse('agent is live in another workspace')
  if (!['idle', 'done'].includes(agent.agent_status ?? '')) return refuse(`agent ${agent.agent_status === 'working' ? 'busy' : agent.agent_status === 'blocked' ? 'blocked' : 'state is not idle or done'}`)
  if (agent.pane_id === input.leadPane) return refuse('cannot close the lead pane')
  const session = agent.agent_session
  if (agent.agent !== 'codex' || session?.kind !== 'id' || session.source !== 'herdr:codex' || typeof session.value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.value)) return refuse('Codex session uuid unavailable')
  finished.uuid = session.value
  finished.pane = agent.pane_id

  // Herdr removes a tab when its last pane closes; never issue a broader tab-close command.
  if (input.agent !== 'analyst' && input.agent !== 'architect' && agent.tab_id) {
    const tabs = await run(['herdr', 'tab', 'list', '--workspace', input.workspace], { timeoutMs: 2_000 }).catch(() => undefined)
    if (!tabs || tabs.exitCode !== 0) return refuse(tabs ? errorOf(tabs) : 'tab list failed')
    const listed = result(tabs.stdout)?.tabs
    if (tabs.isStdoutTruncated || !Array.isArray(listed)) return refuse('tab list unreadable')
    const tab = listed.find(tab => tab?.tab_id === agent.tab_id && tab.workspace_id === input.workspace)
    const slug = input.agent.slice(input.agent.indexOf('-') + 1)
    if (tab?.pane_count === 1 && tab.label === `codex · ${slug}`) finished.tab = agent.tab_id
  }

  // Check the exact name/pane pair again after metadata reads, immediately before closing.
  const agents = await listAgents(run, { timeoutMs: 2_000 }).catch(() => 'agent list failed')
  if (typeof agents === 'string') return refuse(agents)
  const live = agents.find(live => live.name === input.agent)
  if (!live || live.pane_id !== agent.pane_id || live.workspace_id !== input.workspace || agents.some(other => other.pane_id === agent.pane_id && other.name !== input.agent)) return refuse('pane no longer hosts that agent')
  if (!['idle', 'done'].includes(live.agent_status ?? '')) return refuse('agent is no longer idle or done')
  const closed = await run(['herdr', 'pane', 'close', agent.pane_id], { timeoutMs: 2_000 }).catch(() => undefined)
  if (!closed || closed.exitCode !== 0) return refuse(closed ? errorOf(closed) : 'pane close failed')
  finished.closed = true
  for (let poll = 0; poll < 10; poll++) {
    const remaining = await listAgents(run, { timeoutMs: 2_000 }).catch(() => 'agent list failed')
    if (typeof remaining === 'string') return refuse(remaining)
    if (!remaining.some(live => live.name === input.agent || live.pane_id === agent.pane_id)) {
      const archived = await run(['codex', 'archive', session.value], { timeoutMs: 15_000 }).catch(() => undefined)
      if (!archived || archived.exitCode !== 0) return refuse(archived ? `archive exit ${archived.exitCode}` : 'archive call failed')
      return { ...finished, archived: true }
    }
    if (poll < 9) await sleep(250)
  }
  return refuse('agent exit timed out; archive not attempted')
}
