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

/** Where Codex writes the final report of job `id`. */
export const reportPath = (tmpdir: string | undefined, id: number) => `${(tmpdir || '/tmp').replace(/\/+$/, '')}/codex-team/${id}.md`

export type Role = 'dev' | 'qa'
export const loopAgentName = (id: number, role: Role) => `${agentName(id)}-${role}`
export const phaseReportPath = (tmpdir: string | undefined, id: number, role: Role, round: number) =>
  reportPath(tmpdir, id).replace(/\.md$/, `-${role}${round}.md`)
