import { expect, test } from 'claude-code/testing'
import { POLL_MS, pipeline, variables } from '../hooks/pipelines'
import { MR, THEIRS, fakeCtx, paged } from './fake-api'

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
  expect(noMr.calls.at(-1)?.query).toEqual({ ref: 'feature/x', per_page: 10, page: 1 })
})

test('two open MRs of the branch are refused instead of falling back to the branch pipelines', async () => {
  const own = { ...MR, project_id: 1, source_project_id: 1 }
  const { ctx, calls } = fakeCtx({ 'GET /merge_requests': [own, { ...own, iid: 9 }], 'GET /pipelines': [P(91, 'running')] })
  await expect(pipeline(ctx, { action: 'jobs' })).rejects.toThrow('Open merge requests !7, !9 all have feature/x as their source branch. Pass iid.')
  expect(calls.map((c) => c.path)).toEqual(['/merge_requests'])
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

test('list reads the page asked for and says when there are more pipelines', async () => {
  const { ctx, calls } = fakeCtx({ 'GET /pipelines': paged([P(91, 'running')], 3) })
  expect(JSON.parse(await pipeline(ctx, { action: 'list', ref: 'main', page: 2, perPage: 30 })).next).toBe(3)
  expect(calls[0]?.query).toEqual({ ref: 'main', per_page: 30, page: 2 })
})

test('jobs read the page asked for, after finding the latest pipeline with a page of one', async () => {
  const { ctx, calls } = fakeCtx({
    'GET /merge_requests/7/pipelines': [P(90, 'failed')],
    'GET /pipelines/90/jobs': paged(JOBS, 2),
    'GET /pipelines/90/bridges': [],
  })
  expect(JSON.parse(await pipeline(ctx, { action: 'jobs', iid: 7, perPage: 2 })).next).toBe(2)
  expect(calls.map((c) => [c.path, c.query])).toEqual([
    ['/merge_requests/7/pipelines', { per_page: 1, page: 1 }],
    ['/pipelines/90/jobs', { per_page: 2, page: 1 }],
    ['/pipelines/90/bridges', { per_page: 100 }],
  ])
})

test('run starts a merge request pipeline for the iid or the current branch MR, and a ref pipeline with variables', async () => {
  const { ctx, writes } = fakeCtx({
    'GET /merge_requests': [MR],
    'GET /merge_requests/7': MR,
    'POST /merge_requests/7/pipelines': P(100, 'created'),
    'POST /pipeline': P(101, 'created'),
  })

  expect(JSON.parse(await pipeline(ctx, { action: 'run' })).from).toBe('MR !7')
  await pipeline(ctx, { action: 'run', iid: 7 })
  const byRef = JSON.parse(await pipeline(ctx, { action: 'run', ref: 'main', variables: ['DEPLOY=staging', 'NOTE=a=b'] }))

  expect(byRef).toEqual({ from: 'main', pipeline: { id: 101, status: 'created', ref: 'feature/x', sha: 'abcdef01', source: 'push', url: 'u/101' } })
  expect(writes().map((c) => [c.path, c.body])).toEqual([
    ['/merge_requests/7/pipelines', undefined],
    ['/merge_requests/7/pipelines', undefined],
    [
      '/pipeline',
      {
        ref: 'main',
        variables: [
          { key: 'DEPLOY', value: 'staging', variable_type: 'env_var' },
          { key: 'NOTE', value: 'a=b', variable_type: 'env_var' },
        ],
      },
    ],
  ])
})

test('run without an MR for the branch starts a pipeline of the branch, and variables never go to an MR pipeline', async () => {
  const { ctx, writes } = fakeCtx({ 'GET /merge_requests': [], 'POST /pipeline': P(101, 'created') })
  expect(JSON.parse(await pipeline(ctx, { action: 'run' })).from).toBe('feature/x')
  expect(writes()[0]?.body).toEqual({ ref: 'feature/x' })
  await expect(pipeline(ctx, { action: 'run', iid: 7, variables: ['A=1'] })).rejects.toThrow(/variables apply only to a ref pipeline/)
  await expect(pipeline(ctx, { action: 'run', iid: 7, ref: 'main' })).rejects.toThrow('run takes iid or ref, not both.')
  expect(variables(['PASSWORD=secret ', 'PAD=  x'])).toEqual([
    { key: 'PASSWORD', value: 'secret ', variable_type: 'env_var' },
    { key: 'PAD', value: '  x', variable_type: 'env_var' },
  ])
  expect(() => variables(['1BAD=x'])).toThrow('variables are KEY=value strings, the key letters, digits and underscores.')
  expect(() => variables(['NOEQUALS'])).toThrow(/KEY=value/)
})

test("run of a merge request pipeline on someone else's MR needs allowOthers", async () => {
  const { ctx, writes } = fakeCtx({ 'GET /merge_requests/7': THEIRS, 'POST /merge_requests/7/pipelines': P(100, 'created') })
  await expect(pipeline(ctx, { action: 'run', iid: 7 })).rejects.toThrow(/allowOthers: true/)
  expect(writes()).toEqual([])
  await pipeline(ctx, { action: 'run', iid: 7, allowOthers: true })
  expect(writes()).toHaveLength(1)
})

test('artifacts lists a job artifacts with their expiry and gives URLs that carry no token', async () => {
  const { ctx } = fakeCtx({
    'GET /jobs/5': {
      ...JOBS[0],
      id: 5,
      web_url: 'https://gitlab.example.com/g/p/-/jobs/5',
      artifacts: [
        { file_type: 'archive', filename: 'artifacts.zip', size: 2048 },
        { file_type: 'junit', filename: 'junit.xml.gz', size: 300 },
      ],
      artifacts_file: { filename: 'artifacts.zip', size: 2048 },
      artifacts_expire_at: '2026-11-01T00:00:00Z',
    },
    'GET /jobs/6': { ...JOBS[0], id: 6, artifacts: [] },
  })

  expect(JSON.parse(await pipeline(ctx, { action: 'artifacts', jobId: 5 }))).toEqual({
    job: 5,
    name: 'lint',
    status: 'success',
    expires: '2026-11-01T00:00:00Z',
    files: [
      { type: 'archive', name: 'artifacts.zip', size: 2048 },
      { type: 'junit', name: 'junit.xml.gz', size: 300 },
    ],
    download: 'https://gitlab.example.com/api/v4/projects/g%2Fp/jobs/5/artifacts',
    browse: 'https://gitlab.example.com/g/p/-/jobs/5/artifacts/browse',
  })
  expect(JSON.parse(await pipeline(ctx, { action: 'artifacts', jobId: 6 }))).toEqual({ job: 6, name: 'lint', status: 'success', files: [] })
  await expect(pipeline(ctx, { action: 'artifacts' })).rejects.toThrow('artifacts needs jobId (from jobs).')
})

test('wait polls the latest pipeline every 15 seconds until it ends, then answers each failed job with an excerpt of its log, blocking ones first', async () => {
  let polls = 0
  const { ctx, calls, clock } = fakeCtx({
    'GET /merge_requests': [MR],
    'GET /merge_requests/7/pipelines': [P(90, 'running')],
    'GET /pipelines/90': () => (++polls < 3 ? P(90, polls === 1 ? 'pending' : 'running') : P(90, 'failed')),
    'GET /pipelines/90/jobs': [
      { ...JOBS[1], id: 5, name: 'flaky', allow_failure: true },
      JOBS[1],
      { ...JOBS[1], id: 6, name: 'e2e' },
    ],
    'GET /jobs/5/trace': 'warning only',
    'GET /jobs/2/trace': 'setup\nError: expected 1 to be 2\ndone',
    'GET /pipelines/90/bridges': [
      { name: 'deploy', stage: 'post', status: 'success', downstream_pipeline: { id: 95, status: 'failed' } },
      { name: 'docs', stage: 'post', status: 'success', downstream_pipeline: { id: 97, status: 'success' } },
    ],
  })

  const out = JSON.parse(await pipeline(ctx, { action: 'wait' }))

  expect(clock.slept).toEqual([POLL_MS, POLL_MS])
  expect(calls.find((c) => c.path === '/pipelines/90/jobs')?.query).toEqual({ 'scope[]': 'failed', per_page: 100 })
  expect(out).toMatchObject({ pipeline: { id: 90, status: 'failed' }, finished: true, waited: 30 })
  expect(out.failed.map((j: { name: string }) => j.name)).toEqual(['unit', 'e2e', 'flaky'])
  expect(out.failed[0].log).toContain('    2| Error: expected 1 to be 2')
  expect(out.failed[1].log).toBe('(log not readable: 404)')
  expect(out.failed[2]).toMatchObject({ allowFailure: true, log: '    1| warning only' })
  expect(out.downstream).toEqual([{ name: 'deploy', status: 'success', pipeline: 95, pipelineStatus: 'failed' }])
})

test('wait stops at its time limit with the pipeline still running, and refuses more than 30 minutes before any call', async () => {
  const { ctx, clock, calls } = fakeCtx({ 'GET /pipelines/90': P(90, 'running') })

  const out = JSON.parse(await pipeline(ctx, { action: 'wait', pipelineId: 90, minutes: 1 }))

  expect(out).toEqual({
    pipeline: { id: 90, status: 'running', ref: 'feature/x', sha: 'abcdef01', source: 'push', url: 'u/90' },
    finished: false,
    waited: 60,
    next: 'still running after 1 min: call wait again to keep waiting',
  })
  expect(clock.slept).toEqual([POLL_MS, POLL_MS, POLL_MS, POLL_MS])
  expect(calls.filter((c) => c.path === '/pipelines/90')).toHaveLength(5)

  const before = calls.length
  await expect(pipeline(ctx, { action: 'wait', pipelineId: 90, minutes: 31 })).rejects.toThrow('minutes is at most 30.')
  expect(calls).toHaveLength(before)
})

test('wait reads the logs of the first five failed jobs and lists the rest for gitlab_job_log', async () => {
  const failed = Array.from({ length: 7 }, (_, i) => ({ ...JOBS[1], id: 10 + i, name: `job${i}` }))
  const routes: Record<string, unknown> = { 'GET /pipelines/90': P(90, 'failed'), 'GET /pipelines/90/jobs': failed, 'GET /pipelines/90/bridges': [] }
  for (const j of failed) routes[`GET /jobs/${j.id}/trace`] = `error in ${j.name}`
  const { ctx, calls, clock } = fakeCtx(routes as never)

  const out = JSON.parse(await pipeline(ctx, { action: 'wait', pipelineId: 90 }))

  expect(clock.slept).toEqual([])
  expect(out.failed.map((j: { log?: string }) => j.log !== undefined)).toEqual([true, true, true, true, true, false, false])
  expect(out.more).toBe('read the other failed jobs with gitlab_job_log')
  expect(calls.filter((c) => c.path.endsWith('/trace'))).toHaveLength(5)
})
