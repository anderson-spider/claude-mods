export const PREFIX = 'ct-'

/** The Herdr agent name of job `id`. */
export const agentName = (id: number) => `${PREFIX}${id}`

/** Whether a Herdr agent name belongs to a job or loop of this plugin. */
export const isAgentName = (name: string): boolean => name.startsWith(PREFIX)

/** The smallest id from `from` whose agent name is not among the live ones. */
export function nextFreeId(from: number, live: readonly string[]): number {
  let id = from
  while (live.some(name => name === agentName(id) || name === loopAgentName(id, 'dev') || name === loopAgentName(id, 'qa'))) id++
  return id
}

export const JOB_LIMIT_MS = 30 * 60_000
// `$.process.run` kills a child after 10 minutes at most: every wait runs in chunks below that.
export const WAIT_CHUNK_MS = 540_000
// Esc ends the Codex turn but keeps its background terminals (openai/codex#14602); /stop ends them once the turn has settled.
export const STOP_WAIT_MS = 15_000

const reportDir = (tmpdir: string | undefined) => `${(tmpdir || '/tmp').replace(/\/+$/, '')}/codex-team`

/** Where Codex writes the final report of job `id`. */
export const reportPath = (tmpdir: string | undefined, id: number) => `${reportDir(tmpdir)}/${id}.md`

/** Where the report of loop `id` is written. */
export const loopReportPath = (tmpdir: string | undefined, id: number) => `${reportDir(tmpdir)}/loop-${id}.md`

export type Role = 'dev' | 'qa'
export const loopAgentName = (id: number, role: Role) => `${agentName(id)}-${role}`
export const phaseReportPath = (tmpdir: string | undefined, id: number, role: Role, round: number) =>
  reportPath(tmpdir, id).replace(/\.md$/, `-${role}${round}.md`)
