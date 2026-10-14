// gitlab_mr: list, read, create, change and merge merge requests. Merging is guarded: an explicit iid and head sha,
// the token's own MR (else allowOthers), no draft, conflict or blocking discussion, and no protected target other
// than main, master or develop (else allowProtectedTarget).
import type { McpToolInputs } from 'claude-code'
import { GitlabError } from './api'
import {
  InputError,
  bool,
  clip,
  id,
  items,
  json,
  more,
  mrIid,
  need,
  paging,
  str,
  strings,
  userIds,
  username,
  writable,
  type Ctx,
  type User,
} from './context'
import { requireLabels } from './labels'

export type MrAction = McpToolInputs['mcp__gitlab__gitlab_mr']['action']
export type MrInput = { [K in keyof McpToolInputs['mcp__gitlab__gitlab_mr']]?: unknown }

type Pipeline = { id: number; status: string; sha?: string; web_url?: string }
type Mr = {
  iid: number
  title: string
  description?: string | null
  state: string
  draft?: boolean
  source_branch: string
  target_branch: string
  sha?: string
  author?: User
  assignees?: User[]
  reviewers?: User[]
  labels?: string[]
  detailed_merge_status?: string
  merge_status?: string
  has_conflicts?: boolean
  blocking_discussions_resolved?: boolean
  head_pipeline?: Pipeline | null
  references?: { full?: string }
  web_url: string
}

const names = (users: User[] | undefined) => (users ?? []).map((u) => u.username).filter(Boolean)

/** The fields of a merge request worth reading; GitLab's own answer is many times longer. */
export function summary(mr: Mr, withDescription = false, withProject = false): Record<string, unknown> {
  return {
    iid: mr.iid,
    ...(withProject ? { ref: mr.references?.full } : {}),
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
const SCOPES = new Set(['created_by_me', 'assigned_to_me', 'all'])

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

/** The labels the MR is about to get must exist (or be created with createMissingLabels) before it is written. */
async function checkLabels(ctx: Ctx, input: MrInput): Promise<void> {
  const wanted = [...(strings(input.labels) ?? []), ...(strings(input.addLabels) ?? [])]
  if (wanted.length) await requireLabels(ctx, wanted, bool(input.createMissingLabels) === true)
}

async function list(ctx: Ctx, input: MrInput): Promise<string> {
  const state = str(input.state) ?? 'opened'
  if (!STATES.has(state)) throw new InputError('state must be opened, merged, closed or all.')
  let scope = str(input.scope)
  if (scope !== undefined && !SCOPES.has(scope)) throw new InputError('scope must be created_by_me, assigned_to_me or all.')
  const who = async (value: unknown) => (str(value) === undefined ? undefined : username(ctx, str(value)!))
  const author = await who(input.author)
  const assignee = await who(input.assignee)
  const reviewer = await who(input.reviewer)
  const everywhere = bool(input.allProjects) === true
  // the global list defaults to the token's own MRs (created_by_me), which would hide a filter on someone else
  if (everywhere && scope === undefined && (author || assignee || reviewer)) scope = 'all'
  const query = {
    state,
    scope,
    source_branch: str(input.sourceBranch),
    target_branch: str(input.targetBranch),
    author_username: author,
    assignee_username: assignee,
    reviewer_username: reviewer,
    labels: strings(input.labels)?.join(','),
    search: str(input.search),
    order_by: 'updated_at',
    ...paging(input, 20),
  }
  const page = everywhere ? await ctx.api.rootPage('/merge_requests', query) : await ctx.api.page('/merge_requests', query)
  return clip(json({ mergeRequests: items<Mr>(page).map((mr) => summary(mr, false, everywhere)), ...more(page) }), 'pass filters or a smaller perPage')
}

async function create(ctx: Ctx, input: MrInput): Promise<string> {
  const title = need(str(input.title), 'create needs a title.')
  const source = str(input.sourceBranch) ?? (await ctx.branch())
  if (!source) throw new InputError(ctx.foreign ? 'create needs sourceBranch when project names another project.' : 'create needs sourceBranch: the current branch is unknown (detached HEAD).')
  await checkLabels(ctx, input)
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
  const current = await writable<Mr>(ctx, iid, input.allowOthers)
  await checkLabels(ctx, input)
  const body = await fields(ctx, input)
  const add = strings(input.addLabels)
  const remove = strings(input.removeLabels)
  if (add) body.add_labels = add.join(',')
  if (remove) body.remove_labels = remove.join(',')
  const event = str(input.stateEvent)
  if (event !== undefined && event !== 'close' && event !== 'reopen') throw new InputError('stateEvent must be close or reopen.')
  if (event) body.state_event = event
  const draft = bool(input.draft)
  const title = str(input.title) ?? (draft !== undefined ? current.title : undefined)
  if (title !== undefined) body.title = withDraft(title, draft)
  if (Object.keys(body).length === 0) throw new InputError('update was given nothing to change.')
  return json(summary((await ctx.api.send('PUT', `/merge_requests/${iid}`, body)) as Mr))
}

/** An answer GitLab may withhold (approval rules are a paid feature): undefined on 403 or 404. */
async function optional<T>(read: Promise<unknown>): Promise<T | undefined> {
  try {
    return (await read) as T
  } catch (err) {
    if (err instanceof GitlabError && (err.status === 403 || err.status === 404)) return undefined
    throw err
  }
}

type Approvals = { approved?: boolean; approvals_left?: number; approved_by?: { user?: User }[] }
type ApprovalState = { rules?: { name: string; approved?: boolean; approvals_required?: number; approved_by?: User[] }[] }

/** Everything that decides whether the MR can be merged, and the reasons it cannot yet (`blockers`). */
export function statusView(mr: Mr, approvals: Approvals | undefined, state: ApprovalState | undefined): Record<string, unknown> {
  const head = mr.head_pipeline ?? undefined
  const current = head?.sha !== undefined && mr.sha !== undefined ? head.sha === mr.sha : undefined
  const blockers: string[] = []
  if (mr.state !== 'opened') blockers.push(`state is ${mr.state}`)
  if (mr.draft) blockers.push('draft')
  if (mr.has_conflicts) blockers.push('conflicts')
  if (mr.blocking_discussions_resolved === false) blockers.push('unresolved blocking discussions')
  if (!head) blockers.push('no pipeline')
  else if (head.status !== 'success') blockers.push(`pipeline ${head.status}`)
  if (current === false) blockers.push('pipeline is not of the head commit')
  if ((approvals?.approvals_left ?? 0) > 0) blockers.push(`${approvals!.approvals_left} approvals missing`)
  const merge = mr.detailed_merge_status ?? mr.merge_status
  if (merge !== undefined && merge !== 'mergeable' && merge !== 'can_be_merged') blockers.push(`merge status ${merge}`)
  return {
    iid: mr.iid,
    title: mr.title,
    state: mr.state,
    draft: mr.draft,
    source: mr.source_branch,
    target: mr.target_branch,
    sha: mr.sha,
    author: mr.author?.username,
    assignees: names(mr.assignees),
    reviewers: names(mr.reviewers),
    labels: mr.labels ?? [],
    mergeStatus: merge,
    conflicts: mr.has_conflicts,
    discussionsResolved: mr.blocking_discussions_resolved,
    pipeline: head ? { id: head.id, status: head.status, url: head.web_url, sha: head.sha, current } : null,
    approvals: approvals
      ? { approved: approvals.approved, left: approvals.approvals_left, by: (approvals.approved_by ?? []).map((a) => a.user?.username).filter(Boolean) }
      : undefined,
    rules: state?.rules?.map((r) => ({ name: r.name, approved: r.approved, required: r.approvals_required, by: names(r.approved_by) })),
    blockers,
    url: mr.web_url,
  }
}

async function status(ctx: Ctx, input: MrInput): Promise<string> {
  const iid = await mrIid(ctx, input.iid)
  const mr = (await ctx.api.get(`/merge_requests/${iid}`)) as Mr
  const approvals = await optional<Approvals>(ctx.api.get(`/merge_requests/${iid}/approvals`))
  const state = await optional<ApprovalState>(ctx.api.get(`/merge_requests/${iid}/approval_state`))
  return json(statusView(mr, approvals, state))
}

/** Targets an MR of the user's may merge into without allowProtectedTarget. */
const OPEN_TARGETS = new Set(['main', 'master', 'develop'])
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/** Refuses a `release*` target, or any protected one besides main, master and develop, unless allowProtectedTarget. */
async function checkTarget(ctx: Ctx, target: string, allow: unknown): Promise<void> {
  if (bool(allow) === true || OPEN_TARGETS.has(target)) return
  const refused = `The target ${target} is a release or protected branch; merging into it needs allowProtectedTarget: true, only when the user asked for it.`
  if (/^release/i.test(target)) throw new InputError(refused)
  let branch: { protected?: boolean }
  try {
    // the branch name comes from GitLab's own answer, and encoding keeps it one path segment
    branch = (await ctx.api.get(`/repository/branches/${encodeURIComponent(target)}`)) as typeof branch
  } catch (err) {
    if (err instanceof GitlabError) throw new InputError(`Could not tell whether ${target} is protected (GitLab answered ${err.status}), so the merge is refused. ${refused}`)
    throw err
  }
  if (branch.protected !== false) throw new InputError(refused)
}

async function merge(ctx: Ctx, input: MrInput): Promise<string> {
  const iid = need(id(input.iid, 'iid'), "merge needs iid: it never defaults to the current branch's MR.")
  const sha = need(str(input.sha), 'merge needs sha, the head commit from status, so GitLab refuses it if the head moved.').trim().toLowerCase()
  if (!SHA.test(sha)) throw new InputError('sha must be the full head commit sha from status.')
  const mr = await writable<Mr>(ctx, iid, input.allowOthers)
  if (mr.state !== 'opened') throw new InputError(`MR !${iid} is ${mr.state}, not open.`)
  const blockers = [mr.draft && 'it is a draft', mr.has_conflicts && 'it has conflicts', mr.blocking_discussions_resolved === false && 'blocking discussions are unresolved'].filter(Boolean)
  if (blockers.length) throw new InputError(`MR !${iid} cannot be merged: ${blockers.join(', ')}.`)
  if (mr.sha && mr.sha.toLowerCase() !== sha) throw new InputError(`The head of MR !${iid} is now ${mr.sha.slice(0, 8)}, not ${sha.slice(0, 8)}: read status again before merging.`)
  await checkTarget(ctx, mr.target_branch, input.allowProtectedTarget)
  const body: Record<string, unknown> = { sha }
  const set = (k: string, v: boolean | undefined) => v !== undefined && (body[k] = v)
  set('squash', bool(input.squash))
  set('should_remove_source_branch', bool(input.removeSourceBranch))
  set('merge_when_pipeline_succeeds', bool(input.whenPipelineSucceeds))
  return json(summary((await ctx.api.send('PUT', `/merge_requests/${iid}/merge`, body)) as Mr))
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
  let next: number | undefined
  try {
    const page = await ctx.api.page(`/merge_requests/${iid}/diffs`, paging(input, 100))
    diffs = items<Diff>(page)
    next = page.next
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
  const rest = next === undefined ? '' : ` (more files: pass page ${next})`
  return clip(`MR !${iid}: ${chosen.length} of ${diffs.length} files${rest}\n${text}`, 'pass files to read fewer files')
}

async function commits(ctx: Ctx, input: MrInput): Promise<string> {
  const iid = await mrIid(ctx, input.iid)
  const page = await ctx.api.page(`/merge_requests/${iid}/commits`, paging(input, 100))
  const list = items<{ short_id: string; title: string; author_name: string }>(page)
  return json({ commits: list.map((c) => ({ sha: c.short_id, title: c.title, author: c.author_name })), ...more(page) })
}

export async function mr(ctx: Ctx, input: MrInput): Promise<string> {
  switch (input.action as MrAction) {
    case 'list':
      return list(ctx, input)
    case 'get': {
      const iid = await mrIid(ctx, input.iid)
      return json(summary((await ctx.api.get(`/merge_requests/${iid}`)) as Mr, true))
    }
    case 'status':
      return status(ctx, input)
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
      await writable(ctx, iid, input.allowOthers)
      await ctx.api.send('POST', `/merge_requests/${iid}/${input.action}`)
      return `MR !${iid} ${input.action}d.`
    }
    case 'rebase': {
      const iid = await mrIid(ctx, input.iid)
      await writable(ctx, iid, input.allowOthers)
      await ctx.api.send('PUT', `/merge_requests/${iid}/rebase`)
      return `Rebase of MR !${iid} started; get it again to see when it ends.`
    }
    case 'merge':
      return merge(ctx, input)
    default:
      throw new InputError(`Unknown action: ${String(input.action)}.`)
  }
}
