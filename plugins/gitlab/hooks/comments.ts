// gitlab_mr_comment: read and write a merge request's discussions, directly or as draft notes published later; writes
// only on the token's own MR unless allowOthers. Deleting a comment or a draft is not offered.
import type { McpToolInputs } from 'claude-code'
import { GitlabError } from './api'
import { InputError, bool, clip, id, items, json, more, mrIid, need, paging, str, writable, type Ctx, type User } from './context'

export type CommentAction = McpToolInputs['mcp__gitlab__gitlab_mr_comment']['action']
export type CommentInput = { [K in keyof McpToolInputs['mcp__gitlab__gitlab_mr_comment']]?: unknown }

type Note = {
  id: number
  body: string
  system?: boolean
  resolvable?: boolean
  resolved?: boolean
  author?: { username?: string }
  created_at?: string
  position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null } | null
}
type Discussion = { id: string; notes: Note[] }
type DraftNote = { id: number; note: string; discussion_id?: string | null; position?: Note['position'] }

/** A draft note as the model needs it: its id (for edit and publish), the thread it answers and where in the diff. */
export function draftView(d: DraftNote): Record<string, unknown> {
  const at = d.position
  return {
    id: d.id,
    discussionId: d.discussion_id ?? undefined,
    at: at?.new_path || at?.old_path ? { path: at.new_path ?? at.old_path, line: at.new_line ?? undefined, oldLine: at.old_line ?? undefined } : undefined,
    body: d.note,
  }
}

/** A discussion as the model needs it: who said what, where in the diff, and whether it is resolved. System notes are left out. */
export function discussionView(d: Discussion): Record<string, unknown> | undefined {
  const notes = d.notes.filter((n) => !n.system)
  const first = notes[0]
  if (!first) return undefined
  const at = first.position
  return {
    id: d.id,
    resolved: first.resolvable ? notes.every((n) => !n.resolvable || n.resolved) : undefined,
    at: at ? { path: at.new_path ?? at.old_path, line: at.new_line ?? undefined, oldLine: at.old_line ?? undefined } : undefined,
    notes: notes.map((n) => ({ id: n.id, author: n.author?.username, at: n.created_at, body: n.body })),
  }
}

/** At most this many pages of 100 discussions are read to find the unresolved ones. */
const DISCUSSION_PAGES = 20
/** A note's body in the unresolved answer is cut at this many characters. */
const BODY_CHARS = 1_500

const short = (text: string) => (text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS)}…` : text)

/** An unresolved discussion in brief: where, who opened it and what they asked, and the last word when there are replies. */
export function unresolvedView(d: Discussion): Record<string, unknown> | undefined {
  const view = discussionView(d)
  if (!view || view.resolved !== false) return undefined
  const notes = d.notes.filter((n) => !n.system)
  const first = notes[0]!
  const last = notes.at(-1)!
  return {
    id: d.id,
    at: view.at,
    author: first.author?.username,
    body: short(first.body),
    replies: notes.length - 1,
    last: notes.length > 1 ? { id: last.id, author: last.author?.username, at: last.created_at, body: short(last.body) } : undefined,
  }
}

/** Every unresolved discussion of the MR, reading up to `DISCUSSION_PAGES` pages. */
async function unresolved(ctx: Ctx, iid: number): Promise<string> {
  const open: Record<string, unknown>[] = []
  let page: number | undefined = 1
  for (let read = 0; page !== undefined && read < DISCUSSION_PAGES; read++) {
    const got = await ctx.api.page(`/merge_requests/${iid}/discussions`, { per_page: 100, page })
    open.push(...items<Discussion>(got).map(unresolvedView).filter((v) => v !== undefined))
    page = got.next
  }
  return clip(
    json({ unresolved: open, ...(page === undefined ? {} : { next: page, note: `stopped after ${DISCUSSION_PAGES * 100} discussions: list from page ${page} with unresolvedOnly` }) }),
    'list with unresolvedOnly and a smaller perPage',
  )
}

const DISCUSSION = /^[0-9a-f]{1,64}$/i
/** At most this many pages of 100 files are read to find a renamed file's paths. */
const DIFF_PAGES = 50

function discussionId(value: unknown): string {
  const d = need(str(value), 'This action needs discussionId (from list).')
  if (!DISCUSSION.test(d)) throw new InputError('discussionId is not a GitLab discussion id.')
  return d
}

const body = (input: CommentInput) => need(str(input.body), 'This action needs a body.')

/** The file's paths before and after the change: a renamed file has two, and GitLab needs both. Either may be given. */
async function diffPaths(ctx: Ctx, iid: number, path: string): Promise<{ old_path: string; new_path: string }> {
  // the diff is paged: read pages until the file shows up or a short page ends the list
  for (let page = 1; page <= DIFF_PAGES; page++) {
    let diffs: { old_path: string; new_path: string }[]
    try {
      diffs = (await ctx.api.get(`/merge_requests/${iid}/diffs`, { per_page: 100, page })) as typeof diffs
    } catch (err) {
      // an instance older than /diffs (GitLab 15.7): the path given serves as both
      if (err instanceof GitlabError && err.status === 404) break
      throw err
    }
    const file = diffs.find((d) => d.new_path === path) ?? diffs.find((d) => d.old_path === path)
    if (file) return { old_path: file.old_path, new_path: file.new_path }
    if (diffs.length < 100) break
  }
  return { old_path: path, new_path: path }
}

type Mr = { author?: User; diff_refs?: { base_sha: string; start_sha: string; head_sha: string } }
type Spot = { path: string; newLine?: number; oldLine?: number }

/** Where a line comment goes, checked before anything is read or written. */
function spot(input: CommentInput): Spot {
  const path = need(str(input.path), 'line needs path, the file as the diff names it.')
  const newLine = id(input.line, 'line')
  const oldLine = id(input.oldLine, 'oldLine')
  if (newLine === undefined && oldLine === undefined) throw new InputError('line needs line (new side) or oldLine (removed line), or both for an unchanged line.')
  return { path, newLine, oldLine }
}

/** The diff position of a line comment, at the MR head. */
async function position(ctx: Ctx, iid: number, mr: Mr, at: Spot): Promise<Record<string, unknown>> {
  const refs = need(mr.diff_refs ?? undefined, 'GitLab gave no diff refs for this merge request yet; try again once its diff is ready.')
  const paths = await diffPaths(ctx, iid, at.path)
  return {
    position_type: 'text',
    base_sha: refs.base_sha,
    start_sha: refs.start_sha,
    head_sha: refs.head_sha,
    new_path: paths.new_path,
    old_path: paths.old_path,
    ...(at.newLine !== undefined ? { new_line: at.newLine } : {}),
    ...(at.oldLine !== undefined ? { old_line: at.oldLine } : {}),
  }
}

/** A draft note: seen only by the token's user until publish posts it, as GitLab's review does. */
async function draft(ctx: Ctx, iid: number, mr: Mr, action: CommentAction, text: string, d?: string, note?: number, at?: Spot): Promise<string> {
  if (action === 'edit') {
    await ctx.api.send('PUT', `/merge_requests/${iid}/draft_notes/${note}`, { note: text })
    return `Draft note ${note} edited.`
  }
  const added = (await ctx.api.send('POST', `/merge_requests/${iid}/draft_notes`, {
    note: text,
    ...(d ? { in_reply_to_discussion_id: d } : {}),
    ...(at ? { position: await position(ctx, iid, mr, at) } : {}),
  })) as DraftNote
  return json({ draft: draftView(added), note: 'Only you see it until publish.' })
}

export async function comment(ctx: Ctx, input: CommentInput): Promise<string> {
  const action = input.action as CommentAction
  if (!['list', 'unresolved', 'drafts', 'comment', 'reply', 'line', 'edit', 'resolve', 'unresolve', 'publish'].includes(action)) {
    throw new InputError(`Unknown action: ${String(input.action)}.`)
  }
  const asDraft = bool(input.draft) === true
  if (asDraft && !['comment', 'reply', 'line', 'edit'].includes(action)) throw new InputError('draft applies to comment, reply, line and edit.')
  // the inputs a write needs are checked before any request
  const d = action === 'reply' || action === 'resolve' || action === 'unresolve' ? discussionId(input.discussionId) : undefined
  const note =
    action === 'edit' ? need(id(input.noteId, 'noteId'), `edit needs noteId (from ${asDraft ? 'drafts' : 'list'}).`) : action === 'publish' ? id(input.noteId, 'noteId') : undefined
  const at = action === 'line' ? spot(input) : undefined
  const text = action === 'comment' || action === 'reply' || action === 'line' || action === 'edit' ? body(input) : ''
  const iid = await mrIid(ctx, input.iid)
  if (action === 'unresolved') return unresolved(ctx, iid)
  if (action === 'list') {
    const page = await ctx.api.page(`/merge_requests/${iid}/discussions`, paging(input, 100))
    const views = items<Discussion>(page).map(discussionView).filter((v) => v !== undefined)
    const shown = bool(input.unresolvedOnly) ? views.filter((v) => v.resolved === false) : views
    return clip(json({ discussions: shown, ...more(page) }), 'pass unresolvedOnly or a smaller perPage')
  }
  if (action === 'drafts') {
    const page = await ctx.api.page(`/merge_requests/${iid}/draft_notes`, paging(input, 100))
    return clip(json({ drafts: items<DraftNote>(page).map(draftView), ...more(page) }), 'pass a smaller perPage')
  }
  // every other action writes: only on the token's own MR unless allowOthers
  const mr = await writable<Mr>(ctx, iid, input.allowOthers)
  if (asDraft) return draft(ctx, iid, mr, action, text, d, note, at)
  switch (action) {
    case 'comment':
      return json({ note: ((await ctx.api.send('POST', `/merge_requests/${iid}/notes`, { body: text })) as Note).id })
    case 'reply': {
      const added = (await ctx.api.send('POST', `/merge_requests/${iid}/discussions/${d}/notes`, { body: text })) as Note
      return json({ discussion: d, note: added.id })
    }
    case 'line': {
      const added = (await ctx.api.send('POST', `/merge_requests/${iid}/discussions`, { body: text, position: await position(ctx, iid, mr, at!) })) as Discussion
      return json(discussionView(added))
    }
    case 'edit':
      await ctx.api.send('PUT', `/merge_requests/${iid}/notes/${note}`, { body: text })
      return `Note ${note} edited.`
    case 'resolve':
    case 'unresolve':
      await ctx.api.send('PUT', `/merge_requests/${iid}/discussions/${d}`, { resolved: action === 'resolve' })
      return `Discussion ${d} ${action}d.`
    case 'publish':
      if (note !== undefined) {
        await ctx.api.send('PUT', `/merge_requests/${iid}/draft_notes/${note}/publish`)
        return `Draft note ${note} published.`
      }
      await ctx.api.send('POST', `/merge_requests/${iid}/draft_notes/bulk_publish`)
      return `Every draft note of yours on !${iid} published.`
  }
}
