import { expect, test } from 'claude-code/testing'
import { HerdrError } from '../hooks/model'
import { runJob } from '../hooks/job'
import { createBook } from '../hooks/book'
import { job, request, setup, pause } from './helpers'

test('runJob runs an execute job to done with its report', async () => {
  const { deps, calls, events } = setup({})
  const j = job()
  await runJob(deps, j, request())
  expect(calls).toEqual(['split down', 'rename w1:p2 ct-1 execute', 'start ct-1 w1:p2 -s workspace-write -a on-request', 'prompt ct-1'])
  expect(j.status).toBe('done')
  expect(j.pane).toBe('w1:p2')
  expect(j.report).toBe('/tmp/codex-team/1.md')
  expect(j.summary).toContain('all done')
  expect(events).toEqual(['finished done'])
})

test('runJob starts a review job read-only', async () => {
  const { deps, calls } = setup({}, { '/tmp/codex-team/1.md': 'findings' })
  await runJob(deps, job('review'), request('review'))
  expect(calls[1]).toBe('rename w1:p2 ct-1 review')
  expect(calls[2]).toBe('start ct-1 w1:p2 -s read-only -a on-request')
  expect(calls.some(call => call.startsWith('close'))).toBe(false)
})

test('a standalone job closes its pane once its report is written, and open panes share a row below the lead', async () => {
  const { deps, calls } = setup({})
  const book = createBook(deps)
  for (const kind of ['execute', 'review', 'execute'] as const) {
    const j = await book.start(request(kind))
    await book.ended(j.id)
    expect(j.status).toBe('done')
  }
  // Only ct-1 wrote a report: its pane goes, so ct-2 opens below the lead again and ct-3 to its right.
  expect(calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split down', 'split right w1:p3'])
  expect(calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2'])
})

test('a failed standalone job keeps its pane open to look at', async () => {
  const { deps, calls } = setup({ prompt: [new Error('broken')] })
  const book = createBook(deps)
  const j = await book.start(request('execute'))
  await book.ended(j.id)
  expect(j.status).toBe('failed')
  expect(calls.some(call => call.startsWith('close'))).toBe(false)
})

test('a missing last pane retries once below the lead and records the replacement', async () => {
  const { deps, calls } = setup({ split: ['w1:p2', new HerdrError('pane_not_found', 'pane gone'), 'w1:p3', 'w1:p4'] })
  const jobs = [job(), job('review', 2), job('review', 3)]
  for (const j of jobs) await runJob(deps, j, request(j.kind))
  expect(calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2', 'split down', 'split right w1:p3'])
  expect(jobs.map(j => j.pane)).toEqual(['w1:p2', 'w1:p3', 'w1:p4'])
  expect(jobs.map(j => j.status)).toEqual(['done', 'done', 'done'])
})

test('split failures do not poison the opening queue or retry unrelated errors', async () => {
  const { deps, calls } = setup({ split: ['w1:p2', new HerdrError('unknown', 'split failed'), 'w1:p3'] })
  const jobs = [job(), job('review', 2), job('review', 3)]
  for (const j of jobs) await runJob(deps, j, request(j.kind))
  expect(calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2', 'split right w1:p2'])
  expect(jobs.map(j => j.status)).toEqual(['done', 'failed', 'done'])
})

test('a missing lead after the fallback fails without another retry and leaves the tracker clear', async () => {
  const missing = new HerdrError('pane_not_found', 'pane gone')
  const { deps, calls } = setup({ split: ['w1:p2', missing, missing, 'w1:p3'] })
  const jobs = [job(), job('review', 2), job('review', 3)]
  for (const j of jobs) await runJob(deps, j, request(j.kind))
  expect(calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2', 'split down', 'split down'])
  expect(jobs.map(j => j.status)).toEqual(['done', 'failed', 'done'])
})

test('concurrent reviews serialize only their pane openings', async () => {
  let open = () => {}
  let finish = () => {}
  const { deps, calls } = setup({ splitGate: new Promise<void>(done => (open = done)), gate: new Promise<void>(done => (finish = done)) })
  const book = createBook(deps)
  const jobs = await Promise.all([book.start(request('review')), book.start(request('review'))])
  try {
    await pause(5)
    expect(calls.filter(call => call.startsWith('split'))).toEqual(['split down'])
    open()
    await pause(5)
    expect(calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2'])
    expect(jobs.map(j => j.status)).toEqual(['working', 'working'])
  } finally {
    open()
    finish()
    await Promise.all(jobs.map(j => book.ended(j.id)))
  }
  expect(jobs.map(j => j.pane)).toEqual(['w1:p2', 'w1:p3'])
})

test('runJob goes blocked and back to working when the person answers, notifying once', async () => {
  const { deps, calls, events } = setup({ prompt: ['blocked'], wait: ['working', 'idle'] })
  const j = job()
  const seen: string[] = []
  const track = new Proxy(j, {
    set(target, key, value) {
      if (key === 'status') seen.push(value)
      return Reflect.set(target, key, value)
    },
  })
  await runJob(deps, track, request())
  expect(seen).toEqual(['starting', 'working', 'blocked', 'working', 'done'])
  expect(events).toEqual(['blocked blocked', 'finished done'])
  expect(calls.slice(-3)).toEqual(['prompt ct-1', 'wait ct-1 until working|idle|done', 'wait ct-1'])
})

test('runJob treats agent_not_ready at start as blocked and then prompts', async () => {
  const { deps, calls, events } = setup({ start: new HerdrError('agent_not_ready', 'blocked at startup'), wait: ['idle'] })
  const j = job()
  await runJob(deps, j, request())
  expect(events[0]).toBe('blocked blocked')
  expect(calls).toContain('wait ct-1 until working|idle|done')
  expect(calls.at(-1)).toBe('prompt ct-1')
  expect(j.status).toBe('done')
})

test('runJob falls back to the pane text when Codex wrote no report', async () => {
  const { deps } = setup({ read: 'what the pane shows' }, {})
  const j = job()
  await runJob(deps, j, request())
  expect(j.status).toBe('done')
  expect(j.summary).toBe('what the pane shows')
  expect(j.error).toContain('no report')
})

test('runJob fails on agent_prompt_stalled without sending the prompt again', async () => {
  const { deps, calls } = setup({ prompt: [new HerdrError('agent_prompt_stalled', 'no activity')] })
  const j = job()
  await runJob(deps, j, request())
  expect(j.status).toBe('failed')
  expect(j.error).toContain('w1:p2')
  expect(calls.filter(c => c.startsWith('prompt')).length).toBe(1)
})

test('runJob keeps waiting after a chunk timeout and finishes when Codex settles', async () => {
  const { deps, calls } = setup({ prompt: [new HerdrError('timeout', 'chunk')], wait: ['idle'] })
  const j = job()
  await runJob(deps, j, request())
  expect(j.status).toBe('done')
  expect(calls.slice(-2)).toEqual(['prompt ct-1', 'wait ct-1'])
})

test('runJob fails with a timeout once the job limit has passed', async () => {
  const state = setup({ prompt: [new HerdrError('timeout', 'chunk')], onPrompt: () => state.advance(10_000) })
  const j = job()
  await runJob(state.deps, j, request(), { limitMs: 1000 })
  expect(j.status).toBe('failed')
  expect(j.error).toContain('timeout')
  expect(j.error).toContain('w1:p2')
})

test('runJob fails naming the pane when it vanishes mid-job, and still resolves', async () => {
  const { deps } = setup({ prompt: ['blocked'], wait: [new HerdrError('pane_not_found', 'pane gone')] })
  const j = job()
  await runJob(deps, j, request())
  expect(j.status).toBe('failed')
  expect(j.error).toContain('w1:p2')
  expect(j.error).toContain('pane gone')
})

test('a rename failure never fails a standalone job', async () => {
  const { deps, calls } = setup({ rename: new Error('rename failed') })
  const j = job()
  await runJob(deps, j, request())
  expect(calls).toContain('rename w1:p2 ct-1 execute')
  expect(j.status).toBe('done')
})
