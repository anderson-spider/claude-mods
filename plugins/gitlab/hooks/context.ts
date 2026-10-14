// What every tool shares: the API of the repository's project, the current branch, input checks and output size.
import type { Api } from './api'

export type Ctx = {
  api: Api
  /** The checked-out branch, or undefined on a detached HEAD. */
  branch: () => Promise<string | undefined>
}

/** A request the tool refuses before calling the API; its message goes to the model as is. */
export class InputError extends Error {}

/** No open MR has the current branch as its source: the one refusal a caller may answer with the branch itself. */
export class NoMrError extends InputError {}

export const MAX_CHARS = 60_000

/** The text, cut at `MAX_CHARS` with a note saying how to ask for less. */
export function clip(text: string, hint: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…(truncated; ${hint})` : text
}

export const json = (data: unknown): string => JSON.stringify(data)

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()) : undefined
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** A positive integer id, or undefined when absent; anything else is refused. */
export function id(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new InputError(`${name} must be a positive integer.`)
  return n
}

export function need<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new InputError(message)
  return value
}

type MrRef = { iid: number; project_id?: number; source_project_id?: number }

/**
 * The merge request `iid` names, or the one open MR whose source is the current branch in this project. A fork's MR
 * with a branch of the same name is not it, and two candidates (one branch, two targets) are refused, never guessed.
 */
export async function mrIid(ctx: Ctx, iid: unknown): Promise<number> {
  const given = id(iid, 'iid')
  if (given !== undefined) return given
  const branch = await ctx.branch()
  if (!branch) throw new InputError('No iid was given and the current branch is unknown (detached HEAD). Pass iid.')
  const open = (await ctx.api.get('/merge_requests', { state: 'opened', source_branch: branch, per_page: 20 })) as MrRef[]
  const own = (Array.isArray(open) ? open : []).filter((mr) => mr.source_project_id === undefined || mr.source_project_id === mr.project_id)
  if (own.length === 0) throw new NoMrError(`No open merge request has ${branch} as its source branch. Pass iid.`)
  if (own.length > 1) throw new InputError(`Open merge requests ${own.map((mr) => `!${mr.iid}`).join(', ')} all have ${branch} as their source branch. Pass iid.`)
  return own[0]!.iid
}

/** User ids for usernames; `@me` (or `me`) is the token's own user. */
export async function userIds(ctx: Ctx, names: string[]): Promise<number[]> {
  const ids: number[] = []
  for (const raw of names) {
    const name = raw.replace(/^@/, '')
    if (name === 'me') {
      const me = (await ctx.api.root('/user')) as { id?: unknown }
      if (typeof me?.id !== 'number') throw new InputError('GitLab did not say which user the token belongs to.')
      ids.push(me.id)
      continue
    }
    const found = (await ctx.api.root('/users', { username: name })) as { id: number }[]
    const user = Array.isArray(found) ? found[0] : undefined
    if (!user) throw new InputError(`No GitLab user named ${name} on this host.`)
    ids.push(user.id)
  }
  return ids
}
