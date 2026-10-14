// gitlab_mr: list, read, create and change merge requests of the repository's project. Merging is not offered.
import type { McpToolInputs } from 'claude-code'
import { GitlabError } from './api'
import { InputError, bool, clip, json, mrIid, need, str, strings, userIds, type Ctx } from './context'

export type MrAction = McpToolInputs['mcp__gitlab__gitlab_mr']['action']
export type MrInput = { [K in keyof McpToolInputs['mcp__gitlab__gitlab_mr']]?: unknown }

type User = { username?: string }
type Mr = {
  iid: number
  title: string
  description?: string | null
  state: string
  draft?: boolean
  source_branch: string
  target_branch: string
  author?: User
  assignees?: User[]
  reviewers?: User[]
  labels?: string[]
  detailed_merge_status?: string
  merge_status?: string
  has_conflicts?: boolean
  head_pipeline?: { id: number; status: string } | null
  web_url: string
}

const names = (users: User[] | undefined) => (users ?? []).map((u) => u.username).filter(Boolean)

/** The fields of a merge request worth reading; GitLab's own answer is many times longer. */
export function summary(mr: Mr, withDescription = false): Record<string, unknown> {
  return {
    iid: mr.iid,
    title: mr.title,
    state: mr.state,
    draft: mr.draft,
    source: mr.source_branch,
    target: mr.target_branch,
    author: mr.author?.username,
    assignees: names(mr.assignees),
    reviewers: names(mr.reviewers),
    labels: mr.labels ?? [],
    mergeStatus: mr.detailed_merge_status ?? mr.merge_status,
    conflicts: mr.has_conflicts,
    pipeline: mr.head_pipeline ? { id: mr.head_pipeline.id, status: mr.head_pipeline.status } : undefined,
    url: mr.web_url,
    ...(withDescription ? { description: mr.description ?? '' } : {}),
  }
}

const DRAFT = /^\s*(\[draft\]|\(draft\)|draft:|draft\s+-|wip:|\[wip\])\s*/i

/** The title with GitLab's draft prefix added or removed. */
export function withDraft(title: string, draft: boolean | undefined): string {
  if (draft === undefined) return title
  const bare = title.replace(DRAFT, '')
  return draft ? `Draft: ${bare}` : bare
}

const STATES = new Set(['opened', 'merged', 'closed', 'all'])

async function people(ctx: Ctx, value: unknown): Promise<number[] | undefined> {
  const list = strings(value)
  return list === undefined ? undefined : userIds(ctx, list)
}

/** The fields shared by create and update, in GitLab's names; only what was given. */
async function fields(ctx: Ctx, input: MrInput): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {}
  const set = (k: string, v: unknown) => v !== undefined && (body[k] = v)
  set('description', typeof input.description === 'string' ? input.description : undefined)
  set('target_branch', str(input.targetBranch))
  set('labels', strings(input.labels)?.join(','))
  set('assignee_ids', await people(ctx, input.assignees))
  set('reviewer_ids', await people(ctx, input.reviewers))
  set('remove_source_branch', bool(input.removeSourceBranch))
  set('squash', bool(input.squash))
  return body
}

async function list(ctx: Ctx, input: MrInput): Promise<string> {
  const state = str(input.state) ?? 'opened'
  if (!STATES.has(state)) throw new InputError('state must be opened, merged, closed or all.')
  const mrs = (await ctx.api.get('/merge_requests', {
    state,
    source_branch: str(input.sourceBranch),
    target_branch: str(input.targetBranch),
    order_by: 'updated_at',
    per_page: 20,
  })) as Mr[]
  return json(mrs.map((mr) => summary(mr)))
}

async function create(ctx: Ctx, input: MrInput): Promise<string> {
  const title = need(str(input.title), 'create needs a title.')
  const source = str(input.sourceBranch) ?? (await ctx.branch())
  if (!source) throw new InputError('create needs sourceBranch: the current branch is unknown (detached HEAD).')
  const body = await fields(ctx, input)
  if (body.target_branch === undefined) {
    const project = (await ctx.api.get('')) as { default_branch?: string }
    body.target_branch = need(project.default_branch, 'create needs targetBranch: the project has no default branch.')
  }
  const mr = (await ctx.api.send('POST', '/merge_requests', {
    ...body,
    source_branch: source,
    title: withDraft(title, bool(input.draft)),
  })) as Mr
  return json(summary(mr))
}

async function update(ctx: Ctx, input: MrInput): Promise<string> {
  const iid = await mrIid(ctx, input.iid)
  const body = await fields(ctx, input)
  const add = strings(input.addLabels)
  const remove = strings(input.removeLabels)
  if (add) body.add_labels = add.join(',')
  if (remove) body.remove_labels = remove.join(',')
  const event = str(input.stateEvent)
  if (event !== undefined && event !== 'close' && event !== 'reopen') throw new InputError('stateEvent must be close or reopen.')
  if (event) body.state_event = event
  const draft = bool(input.draft)
  let title = str(input.title)
  if (draft !== undefined && title === undefined) title = ((await ctx.api.get(`/merge_requests/${iid}`)) as Mr).title
  if (title !== undefined) body.title = withDraft(title, draft)
  if (Object.keys(body).length === 0) throw new InputError('update was given nothing to change.')
  return json(summary((await ctx.api.send('PUT', `/merge_requests/${iid}`, body)) as Mr))
}

type Diff = {
  old_path: string
  new_path: string
  diff: string
  new_file?: boolean
  deleted_file?: boolean
  renamed_file?: boolean
  too_large?: boolean
  collapsed?: boolean
}

async function diff(ctx: Ctx, input: MrInput): Promise<string> {
  const iid = await mrIid(ctx, input.iid)
  const only = strings(input.files)
  let diffs: Diff[]
  try {
    diffs = (await ctx.api.get(`/merge_requests/${iid}/diffs`, { per_page: 100 })) as Diff[]
  } catch (err) {
    // /diffs arrived in GitLab 15.7; an older instance has only /changes
    if (!(err instanceof GitlabError) || err.status !== 404) throw err
    diffs = ((await ctx.api.get(`/merge_requests/${iid}/changes`)) as { changes?: Diff[] }).changes ?? []
  }
  const chosen = only?.length ? diffs.filter((d) => only.some((f) => d.new_path.includes(f) || d.old_path.includes(f))) : diffs
  const text = chosen
    .map((d) => {
      const head = d.renamed_file ? `${d.old_path} → ${d.new_path}` : d.new_path
      const tag = d.new_file ? ' (new)' : d.deleted_file ? ' (deleted)' : ''
      // past GitLab's diff limits a file comes back with an empty diff: say so, never show it as unchanged
      const omitted = !d.diff && (d.too_large || d.collapsed) ? `(diff omitted by GitLab: ${d.too_large ? 'too large' : 'collapsed'}; open the MR in the browser)\n` : ''
      return `=== ${head}${tag}\n${omitted || d.diff}`
    })
    .join('\n')
  return clip(`MR !${iid}: ${chosen.length} of ${diffs.length} files\n${text}`, 'pass files to read fewer files')
}

async function commits(ctx: Ctx, input: MrInput): Promise<string> {
  const iid = await mrIid(ctx, input.iid)
  const list = (await ctx.api.get(`/merge_requests/${iid}/commits`, { per_page: 100 })) as {
    short_id: string
    title: string
    author_name: string
  }[]
  return json(list.map((c) => ({ sha: c.short_id, title: c.title, author: c.author_name })))
}

export async function mr(ctx: Ctx, input: MrInput): Promise<string> {
  switch (input.action as MrAction) {
    case 'list':
      return list(ctx, input)
    case 'get': {
      const iid = await mrIid(ctx, input.iid)
      return json(summary((await ctx.api.get(`/merge_requests/${iid}`)) as Mr, true))
    }
    case 'create':
      return create(ctx, input)
    case 'update':
      return update(ctx, input)
    case 'diff':
      return diff(ctx, input)
    case 'commits':
      return commits(ctx, input)
    case 'approve':
    case 'unapprove': {
      const iid = await mrIid(ctx, input.iid)
      await ctx.api.send('POST', `/merge_requests/${iid}/${input.action}`)
      return `MR !${iid} ${input.action}d.`
    }
    case 'rebase': {
      const iid = await mrIid(ctx, input.iid)
      await ctx.api.send('PUT', `/merge_requests/${iid}/rebase`)
      return `Rebase of MR !${iid} started; get it again to see when it ends.`
    }
    default:
      throw new InputError(`Unknown action: ${String(input.action)}.`)
  }
}

