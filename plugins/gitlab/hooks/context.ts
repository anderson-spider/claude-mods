// What every tool shares: the API of the chosen project, the current branch, the token's user, input checks, paging,
// the guard on other people's merge requests and output size.
import type { Api, Page, Query } from './api'

export type User = { id?: number; username?: string }

export type Ctx = {
  api: Api
  /** The checked-out branch, or undefined on a detached HEAD or when `project` names another project. */
  branch: () => Promise<string | undefined>
  /** The token's own user, read once per call. */
  me: () => Promise<{ id: number; username?: string }>
  /** `project` named a project other than the remote's, so the current branch says nothing about it. */
  foreign: boolean
}

/** A context whose `me` reads `/user` at most once; with `foreign`, the branch is never read. */
export function makeCtx(api: Api, branch: () => Promise<string | undefined>, foreign = false): Ctx {
  let me: Promise<{ id: number; username?: string }> | undefined
  return {
    api,
    foreign,
    branch: foreign ? async () => undefined : branch,
    me: () =>
      (me ??= (async () => {
        const user = (await api.root('/user')) as User
        if (typeof user?.id !== 'number') throw new InputError('GitLab did not say which user the token belongs to.')
        return { id: user.id, username: typeof user.username === 'string' ? user.username : undefined }
      })()),
  }
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

/** GitLab's largest page. */
export const MAX_PER_PAGE = 100

/** `page` and `perPage` in GitLab's names; `perPage` defaults to `fallback` and is at most 100. */
export function paging(input: { page?: unknown; perPage?: unknown }, fallback: number): Query {
  const per = id(input.perPage, 'perPage') ?? fallback
  if (per > MAX_PER_PAGE) throw new InputError(`perPage is at most ${MAX_PER_PAGE}.`)
  return { per_page: per, page: id(input.page, 'page') ?? 1 }
}

/** A page's items as an array (an answer that is not a list counts as empty). */
export const items = <T>(page: Page): T[] => (Array.isArray(page.data) ? (page.data as T[]) : [])

/** `next` for an answer: the page to ask for when GitLab says there is more. */
export const more = (page: Page): { next?: number } => (page.next === undefined ? {} : { next: page.next })

type MrRef = { iid: number; project_id?: number; source_project_id?: number }

/**
 * The merge request `iid` names, or the one open MR whose source is the current branch in this project. A fork's MR
 * with a branch of the same name is not it, and two candidates (one branch, two targets) are refused, never guessed.
 */
export async function mrIid(ctx: Ctx, iid: unknown): Promise<number> {
  const given = id(iid, 'iid')
  if (given !== undefined) return given
  if (ctx.foreign) throw new InputError('Pass iid: project names another project, so the current branch is not used.')
  const branch = await ctx.branch()
  if (!branch) throw new InputError('No iid was given and the current branch is unknown (detached HEAD). Pass iid.')
  const open = (await ctx.api.get('/merge_requests', { state: 'opened', source_branch: branch, per_page: 20 })) as MrRef[]
  const own = (Array.isArray(open) ? open : []).filter((mr) => mr.source_project_id === undefined || mr.source_project_id === mr.project_id)
  if (own.length === 0) throw new NoMrError(`No open merge request has ${branch} as its source branch. Pass iid, or open one with gitlab_mr create.`)
  if (own.length > 1) throw new InputError(`Open merge requests ${own.map((mr) => `!${mr.iid}`).join(', ')} all have ${branch} as their source branch. Pass iid.`)
  return own[0]!.iid
}

/**
 * The merge request, read so a write can check whose it is: one whose author is not the token's user is refused
 * unless `allowOthers` is true, which the model passes only when the user asked to write on a colleague's MR.
 */
export async function writable<T extends { author?: User }>(ctx: Ctx, iid: number, allowOthers: unknown): Promise<T> {
  const mr = (await ctx.api.get(`/merge_requests/${iid}`)) as T
  if (bool(allowOthers) === true) return mr
  const me = await ctx.me()
  if (mr.author?.id !== me.id) {
    const by = mr.author?.username ? `by ${mr.author.username}` : 'not yours'
    throw new InputError(
      `MR !${iid} is ${by}, not by the token's user${me.username ? ` (${me.username})` : ''}. Writing on someone else's MR needs allowOthers: true; pass it only when the user asked for it.`,
    )
  }
  return mr
}

/** A username for a filter; `@me` (or `me`) is the token's own user. */
export async function username(ctx: Ctx, raw: string): Promise<string> {
  const name = raw.trim().replace(/^@/, '')
  if (name !== 'me') return name
  return need((await ctx.me()).username, 'GitLab did not say which user the token belongs to.')
}

/** User ids for usernames; `@me` (or `me`) is the token's own user. */
export async function userIds(ctx: Ctx, names: string[]): Promise<number[]> {
  const ids: number[] = []
  for (const raw of names) {
    const name = raw.replace(/^@/, '')
    if (name === 'me') {
      ids.push((await ctx.me()).id)
      continue
    }
    const found = (await ctx.api.root('/users', { username: name })) as { id: number }[]
    const user = Array.isArray(found) ? found[0] : undefined
    if (!user) throw new InputError(`No GitLab user named ${name} on this host.`)
    ids.push(user.id)
  }
  return ids
}
