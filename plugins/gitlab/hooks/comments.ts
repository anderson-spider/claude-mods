// gitlab_mr_comment: read and write a merge request's discussions. Deleting a comment is not offered.
import type { McpToolInputs } from 'claude-code'
import { GitlabError } from './api'
import { InputError, bool, clip, id, json, mrIid, need, str, type Ctx } from './context'

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

async function line(ctx: Ctx, iid: number, input: CommentInput): Promise<string> {
  const path = need(str(input.path), 'line needs path, the file as the diff names it.')
  const newLine = id(input.line, 'line')
  const oldLine = id(input.oldLine, 'oldLine')
  if (newLine === undefined && oldLine === undefined) throw new InputError('line needs line (new side) or oldLine (removed line), or both for an unchanged line.')
  const mr = (await ctx.api.get(`/merge_requests/${iid}`)) as { diff_refs?: { base_sha: string; start_sha: string; head_sha: string } }
  const refs = need(mr.diff_refs ?? undefined, 'GitLab gave no diff refs for this merge request yet; try again once its diff is ready.')
  const paths = await diffPaths(ctx, iid, path)
  const d = (await ctx.api.send('POST', `/merge_requests/${iid}/discussions`, {
    body: body(input),
    position: {
      position_type: 'text',
      base_sha: refs.base_sha,
      start_sha: refs.start_sha,
      head_sha: refs.head_sha,
      new_path: paths.new_path,
      old_path: paths.old_path,
      ...(newLine !== undefined ? { new_line: newLine } : {}),
      ...(oldLine !== undefined ? { old_line: oldLine } : {}),
    },
  })) as Discussion
  return json(discussionView(d))
}

export async function comment(ctx: Ctx, input: CommentInput): Promise<string> {
  const action = input.action as CommentAction
  if (!['list', 'comment', 'reply', 'line', 'edit', 'resolve', 'unresolve'].includes(action)) {
    throw new InputError(`Unknown action: ${String(input.action)}.`)
  }
  const iid = await mrIid(ctx, input.iid)
  switch (action) {
    case 'list': {
      const all = (await ctx.api.get(`/merge_requests/${iid}/discussions`, { per_page: 100 })) as Discussion[]
      const views = all.map(discussionView).filter((v) => v !== undefined)
      const shown = bool(input.unresolvedOnly) ? views.filter((v) => v.resolved === false) : views
      return clip(json(shown), 'pass unresolvedOnly to read fewer discussions')
    }
    case 'comment': {
      const note = (await ctx.api.send('POST', `/merge_requests/${iid}/notes`, { body: body(input) })) as Note
      return json({ note: note.id })
    }
    case 'reply': {
      const d = discussionId(input.discussionId)
      const note = (await ctx.api.send('POST', `/merge_requests/${iid}/discussions/${d}/notes`, { body: body(input) })) as Note
      return json({ discussion: d, note: note.id })
    }
    case 'line':
      return line(ctx, iid, input)
    case 'edit': {
      const note = need(id(input.noteId, 'noteId'), 'edit needs noteId (from list).')
      await ctx.api.send('PUT', `/merge_requests/${iid}/notes/${note}`, { body: body(input) })
      return `Note ${note} edited.`
    }
    case 'resolve':
    case 'unresolve': {
      const d = discussionId(input.discussionId)
      await ctx.api.send('PUT', `/merge_requests/${iid}/discussions/${d}`, { resolved: action === 'resolve' })
      return `Discussion ${d} ${action}d.`
    }
  }
}
