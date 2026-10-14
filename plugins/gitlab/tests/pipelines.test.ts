import { expect, test } from 'claude-code/testing'
import { pipeline } from '../hooks/pipelines'
import { MR, fakeCtx } from './fake-api'

const P = (id: number, status: string) => ({ id, status, ref: 'feature/x', sha: 'abcdef0123', source: 'push', web_url: `u/${id}` })
const JOBS = [
  { id: 1, name: 'lint', stage: 'test', status: 'success', duration: 12.4, web_url: 'j/1' },
  { id: 2, name: 'unit', stage: 'test', status: 'failed', duration: 30, failure_reason: 'script_failure', web_url: 'j/2' },
]

test('list prefers the open MR of the current branch, and falls back to the branch when it has none', async () => {
  const withMr = fakeCtx({ 'GET /merge_requests': [MR], 'GET /merge_requests/7/pipelines': [P(90, 'failed')] })
  expect(JSON.parse(await pipeline(withMr.ctx, { action: 'list' }))).toEqual({
    from: 'MR !7',
    pipelines: [{ id: 90, status: 'failed', ref: 'feature/x', sha: 'abcdef01', source: 'push', url: 'u/90' }],
  })

  const noMr = fakeCtx({ 'GET /merge_requests': [], 'GET /pipelines': [P(91, 'running')] })
  expect(JSON.parse(await pipeline(noMr.ctx, { action: 'list' })).from).toBe('feature/x')
  expect(noMr.calls.at(-1)?.query).toEqual({ ref: 'feature/x', per_page: 10 })
})

test('list by ref skips the MR lookup, and an explicit iid without an MR is an error', async () => {
  const { ctx, calls } = fakeCtx({ 'GET /pipelines': [] })
  await pipeline(ctx, { action: 'list', ref: 'main' })
  expect(calls.map((c) => c.path)).toEqual(['/pipelines'])
  await expect(pipeline(ctx, { action: 'list', iid: 9 })).rejects.toThrow(/404/)
})

test('jobs read the latest pipeline by default, with downstream pipelines, and failedOnly keeps failed jobs and failed downstream pipelines', async () => {
  const { ctx } = fakeCtx({
    'GET /merge_requests': [MR],
    'GET /merge_requests/7/pipelines': [P(90, 'failed'), P(80, 'success')],
    'GET /pipelines/90/jobs': JOBS,
    'GET /pipelines/90/bridges': [
      { name: 'deploy', stage: 'post', status: 'failed', downstream_pipeline: { id: 95, status: 'failed' } },
      { name: 'child', stage: 'post', status: 'success', downstream_pipeline: { id: 96, status: 'failed' } },
      { name: 'docs', stage: 'post', status: 'success', downstream_pipeline: { id: 97, status: 'success' } },
    ],
  })

  const out = JSON.parse(await pipeline(ctx, { action: 'jobs', failedOnly: true }))

  expect(out).toEqual({
    pipeline: 90,
    jobs: [{ id: 2, name: 'unit', stage: 'test', status: 'failed', seconds: 30, failure: 'script_failure', url: 'j/2' }],
    downstream: [
      { name: 'deploy', stage: 'post', status: 'failed', pipeline: 95, pipelineStatus: 'failed' },
      { name: 'child', stage: 'post', status: 'success', pipeline: 96, pipelineStatus: 'failed' },
    ],
  })
})

test('retry and cancel act on a job or a pipeline, play only on a job', async () => {
  const { ctx, calls } = fakeCtx({
    'POST /jobs/2/retry': { ...JOBS[1], id: 3, status: 'pending' },
    'POST /pipelines/90/cancel': P(90, 'canceled'),
    'POST /jobs/4/play': { ...JOBS[0], id: 4, status: 'pending' },
  })

  await pipeline(ctx, { action: 'retry', jobId: 2 })
  await pipeline(ctx, { action: 'cancel', pipelineId: 90 })
  await pipeline(ctx, { action: 'play', jobId: 4 })

  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /jobs/2/retry', 'POST /pipelines/90/cancel', 'POST /jobs/4/play'])
  await expect(pipeline(ctx, { action: 'retry' })).rejects.toThrow('retry needs jobId or pipelineId.')
  await expect(pipeline(ctx, { action: 'play', pipelineId: 90 })).rejects.toThrow('play needs the jobId of a manual job.')
})
