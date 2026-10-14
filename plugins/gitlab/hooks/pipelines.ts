// gitlab_pipeline: the pipelines of a merge request or branch, their jobs and artifacts, and running, retrying,
// cancelling or playing them. Downloading artifacts is not offered: the answer gives their URL, never the token.
import type { McpToolInputs } from 'claude-code'
import { InputError, NoMrError, bool, clip, id, items, json, more, mrIid, need, paging, str, strings, writable, type Ctx } from './context'

export type PipelineAction = McpToolInputs['mcp__gitlab__gitlab_pipeline']['action']
export type PipelineInput = { [K in keyof McpToolInputs['mcp__gitlab__gitlab_pipeline']]?: unknown }

type Pipeline = { id: number; status: string; ref: string; sha: string; source?: string; created_at?: string; web_url: string }
type Job = {
  id: number
  name: string
  stage: string
  status: string
  allow_failure?: boolean
  duration?: number | null
  failure_reason?: string
  web_url: string
  artifacts?: { file_type?: string; filename?: string; size?: number }[]
  artifacts_file?: { filename?: string; size?: number } | null
  artifacts_expire_at?: string | null
}
type Bridge = { name: string; stage: string; status: string; downstream_pipeline?: { id: number; status: string; project_id?: number } | null }

export const pipelineView = (p: Pipeline) => ({
  id: p.id,
  status: p.status,
  ref: p.ref,
  sha: p.sha.slice(0, 8),
  source: p.source,
  created: p.created_at,
  url: p.web_url,
})

export const jobView = (j: Job) => ({
  id: j.id,
  name: j.name,
  stage: j.stage,
  status: j.status,
  allowFailure: j.allow_failure || undefined,
  seconds: j.duration == null ? undefined : Math.round(j.duration),
  failure: j.failure_reason,
  url: j.web_url,
})

/** Where pipelines come from: the given iid, the given ref, the open MR of the current branch, else the branch itself. */
async function pipelines(ctx: Ctx, input: PipelineInput): Promise<{ from: string; list: Pipeline[]; next?: number }> {
  const query = paging(input, 10)
  const iid = await mrOrBranch(ctx, input)
  if (iid !== undefined) {
    const page = await ctx.api.page(`/merge_requests/${iid}/pipelines`, query)
    return { from: `MR !${iid}`, list: items<Pipeline>(page), ...more(page) }
  }
  const branch = await refOrBranch(ctx, input)
  const page = await ctx.api.page('/pipelines', { ref: branch, ...query })
  return { from: branch, list: items<Pipeline>(page), ...more(page) }
}

/** The MR to use when no ref was given: iid, else the current branch's open MR; undefined means use a branch. */
async function mrOrBranch(ctx: Ctx, input: PipelineInput): Promise<number | undefined> {
  if (input.iid === undefined && str(input.ref) !== undefined) return undefined
  try {
    return await mrIid(ctx, input.iid)
  } catch (err) {
    // only a branch with no open MR falls back to the branch: two MRs of the branch, or a detached HEAD, are refused
    if (input.iid !== undefined || !(err instanceof NoMrError)) throw err
    return undefined
  }
}

async function refOrBranch(ctx: Ctx, input: PipelineInput): Promise<string> {
  const branch = str(input.ref) ?? (await ctx.branch())
  if (!branch) throw new InputError(ctx.foreign ? 'Pass iid, ref or pipelineId when project names another project.' : 'Pass iid, ref or pipelineId: the current branch is unknown (detached HEAD).')
  return branch
}

const VARIABLE = /^([A-Za-z_][A-Za-z0-9_]{0,254})=([\s\S]*)$/

/** `KEY=value` strings as GitLab's pipeline variables. */
export function variables(value: unknown): { key: string; value: string; variable_type: 'env_var' }[] | undefined {
  const list = strings(value)
  if (!list?.length) return undefined
  return list.map((v) => {
    const m = VARIABLE.exec(v)
    if (!m) throw new InputError('variables are KEY=value strings, the key letters, digits and underscores.')
    return { key: m[1]!, value: m[2]!, variable_type: 'env_var' }
  })
}

/** A merge request pipeline (iid, or the current branch's MR), else a pipeline of ref (or the current branch) with variables. */
async function run(ctx: Ctx, input: PipelineInput): Promise<string> {
  if (input.iid !== undefined && str(input.ref) !== undefined) throw new InputError('run takes iid or ref, not both.')
  const vars = variables(input.variables)
  const iid = vars ? undefined : await mrOrBranch(ctx, input)
  if (iid !== undefined) {
    await writable(ctx, iid, input.allowOthers)
    return json({ from: `MR !${iid}`, pipeline: pipelineView((await ctx.api.send('POST', `/merge_requests/${iid}/pipelines`)) as Pipeline) })
  }
  if (input.iid !== undefined) throw new InputError('variables apply only to a ref pipeline: GitLab takes none for a merge request pipeline. Pass ref instead of iid.')
  const ref = await refOrBranch(ctx, input)
  return json({ from: ref, pipeline: pipelineView((await ctx.api.send('POST', '/pipeline', { ref, ...(vars ? { variables: vars } : {}) })) as Pipeline) })
}

/** A job's artifacts (type, name, size), when they expire, and URLs to fetch or browse them, which need the user's own login. */
async function artifacts(ctx: Ctx, input: PipelineInput): Promise<string> {
  const job = need(id(input.jobId, 'jobId'), 'artifacts needs jobId (from jobs).')
  const meta = (await ctx.api.get(`/jobs/${job}`)) as Job
  const files = (meta.artifacts ?? []).map((a) => ({ type: a.file_type, name: a.filename, size: a.size }))
  const archive = meta.artifacts_file?.filename !== undefined || files.some((f) => f.type === 'archive')
  return json({
    job,
    name: meta.name,
    status: meta.status,
    expires: meta.artifacts_expire_at ?? undefined,
    files,
    download: archive ? ctx.api.url(`/jobs/${job}/artifacts`) : undefined,
    browse: archive && meta.web_url ? `${meta.web_url}/artifacts/browse` : undefined,
  })
}

async function jobs(ctx: Ctx, input: PipelineInput): Promise<string> {
  let pipeline = id(input.pipelineId, 'pipelineId')
  if (pipeline === undefined) {
    const { from, list } = await pipelines(ctx, { ...input, page: undefined, perPage: 1 })
    pipeline = list[0]?.id
    if (pipeline === undefined) throw new InputError(`${from} has no pipeline.`)
  }
  const page = await ctx.api.page(`/pipelines/${pipeline}/jobs`, paging(input, 100))
  const all = items<Job>(page)
  const bridges = (await ctx.api.get(`/pipelines/${pipeline}/bridges`, { per_page: 100 })) as Bridge[]
  const failed = bool(input.failedOnly)
  const shown = failed ? all.filter((j) => j.status === 'failed') : all
  return clip(
    json({
      pipeline,
      jobs: shown.map(jobView),
      // a trigger job without `strategy: mirror` succeeds once it starts the downstream pipeline, so its own status
      // says nothing of that pipeline's: both are reported, and failedOnly keeps either failure
      downstream: (failed ? bridges.filter((b) => b.status === 'failed' || b.downstream_pipeline?.status === 'failed') : bridges).map((b) => ({
        name: b.name,
        stage: b.stage,
        status: b.status,
        pipeline: b.downstream_pipeline?.id,
        pipelineStatus: b.downstream_pipeline?.status,
      })),
      ...more(page),
    }),
    'pass failedOnly to read fewer jobs',
  )
}

export async function pipeline(ctx: Ctx, input: PipelineInput): Promise<string> {
  const action = input.action as PipelineAction
  switch (action) {
    case 'list': {
      const { from, list, next } = await pipelines(ctx, input)
      return json({ from, pipelines: list.map(pipelineView), ...(next === undefined ? {} : { next }) })
    }
    case 'jobs':
      return jobs(ctx, input)
    case 'run':
      return run(ctx, input)
    case 'artifacts':
      return artifacts(ctx, input)
    case 'retry':
    case 'cancel': {
      const job = id(input.jobId, 'jobId')
      if (job !== undefined) return json(jobView((await ctx.api.send('POST', `/jobs/${job}/${action}`)) as Job))
      const p = id(input.pipelineId, 'pipelineId')
      if (p === undefined) throw new InputError(`${action} needs jobId or pipelineId.`)
      return json(pipelineView((await ctx.api.send('POST', `/pipelines/${p}/${action}`)) as Pipeline))
    }
    case 'play': {
      const job = id(input.jobId, 'jobId')
      if (job === undefined) throw new InputError('play needs the jobId of a manual job.')
      return json(jobView((await ctx.api.send('POST', `/jobs/${job}/play`)) as Job))
    }
    default:
      throw new InputError(`Unknown action: ${String(input.action)}.`)
  }
}
