export const PREFIX = 'ct-'

/** The Herdr agent name of job `id`. */
export const agentName = (id: number) => `${PREFIX}${id}`

/** Whether a Herdr agent name belongs to a job or loop of this plugin. */
export const isAgentName = (name: string): boolean => name.startsWith(PREFIX)

/** The smallest id from `from` whose agent name is not among the live ones: a live `ct-<id>-dev` or `-qa` reserves that loop id after a reload. */
export function nextFreeId(from: number, live: readonly string[]): number {
  let id = from
  while (live.some(name => name === agentName(id) || name === loopAgentName(id, 'dev') || name === loopAgentName(id, 'qa'))) id++
  return id
}

// A timeout ends the job's wait, not the agent: it keeps running in its pane.
export const JOB_LIMIT_MS = 30 * 60_000
// `$.process.run` kills a child after 10 minutes at most: every wait runs in chunks below that.
export const WAIT_CHUNK_MS = 540_000
// Esc ends the Codex turn but keeps its background terminals (openai/codex#14602); /stop ends them once the turn has settled.
export const STOP_WAIT_MS = 15_000
// Claude's state is read from its screen, so a settled state can fall between two tool calls: with no report yet, the job
// waits for the agent to stay settled for QUIET_POLLS polls of QUIET_MS before it gives up on the report.
export const QUIET_MS = 10_000
export const QUIET_POLLS = 3

export const reportDir = (tmpdir: string | undefined) => `${(tmpdir || '/tmp').replace(/\/+$/, '')}/codex-team`

/** Where the agent writes the final report of job `id`. */
export const reportPath = (tmpdir: string | undefined, id: number) => `${reportDir(tmpdir)}/${id}.md`

/** Where the report of loop `id` is written. */
export const loopReportPath = (tmpdir: string | undefined, id: number) => `${reportDir(tmpdir)}/loop-${id}.md`

export type Role = 'dev' | 'qa'
export const loopAgentName = (id: number, role: Role) => `${agentName(id)}-${role}`
export const phaseReportPath = (tmpdir: string | undefined, id: number, role: Role, round: number) =>
  reportPath(tmpdir, id).replace(/\.md$/, `-${role}${round}.md`)
