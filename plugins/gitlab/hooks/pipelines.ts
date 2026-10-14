// gitlab_pipeline: the pipelines of a merge request or branch, their jobs, and retrying, cancelling or playing them.
import type { McpToolInputs } from 'claude-code'
import { InputError, bool, clip, id, json, mrIid, str, type Ctx } from './context'

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
async function pipelines(ctx: Ctx, input: PipelineInput): Promise<{ from: string; list: Pipeline[] }> {
  const ref = str(input.ref)
  if (input.iid !== undefined || ref === undefined) {
    let iid: number | undefined
    try {
      iid = await mrIid(ctx, input.iid)
    } catch (err) {
      if (input.iid !== undefined || !(err instanceof InputError)) throw err
    }
    if (iid !== undefined) return { from: `MR !${iid}`, list: (await ctx.api.get(`/merge_requests/${iid}/pipelines`, { per_page: 10 })) as Pipeline[] }
  }
  const branch = ref ?? (await ctx.branch())
  if (!branch) throw new InputError('Pass iid, ref or pipelineId: the current branch is unknown (detached HEAD).')
  return { from: branch, list: (await ctx.api.get('/pipelines', { ref: branch, per_page: 10 })) as Pipeline[] }
}

async function jobs(ctx: Ctx, input: PipelineInput): Promise<string> {
  let pipeline = id(input.pipelineId, 'pipelineId')
  if (pipeline === undefined) {
    const { from, list } = await pipelines(ctx, input)
    pipeline = list[0]?.id
    if (pipeline === undefined) throw new InputError(`${from} has no pipeline.`)
  }
  const all = (await ctx.api.get(`/pipelines/${pipeline}/jobs`, { per_page: 100 })) as Job[]
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
    }),
    'pass failedOnly to read fewer jobs',
  )
}

export async function pipeline(ctx: Ctx, input: PipelineInput): Promise<string> {
  const action = input.action as PipelineAction
  switch (action) {
    case 'list': {
      const { from, list } = await pipelines(ctx, input)
      return json({ from, pipelines: list.map(pipelineView) })
    }
    case 'jobs':
      return jobs(ctx, input)
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
