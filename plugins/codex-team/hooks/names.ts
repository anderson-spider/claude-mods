const PREFIX = 'ct-'

/** The Herdr agent name of job `id`. */
export const agentName = (id: number) => `${PREFIX}${id}`

/** The smallest id from `from` whose agent name is not among the live ones. */
export function nextFreeId(from: number, live: readonly string[]): number {
  let id = from
  while (live.includes(agentName(id))) id++
  return id
}

/** Where Codex writes the final report of job `id`. */
export const reportPath = (tmpdir: string | undefined, id: number) => `${(tmpdir || '/tmp').replace(/\/+$/, '')}/codex-team/${id}.md`
