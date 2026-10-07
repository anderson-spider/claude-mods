import { expect, test } from 'claude-code/testing'
import type { Job } from '../hooks/model'
import { jobDetail, jobsReport } from '../hooks/presentation'
import { request, pause, settled, bookWith } from './helpers'

test('createBook queues execute jobs one at a time while a review starts at once', async () => {
  let release = () => {}
  const { book, calls } = bookWith({ gate: new Promise<void>(done => (release = done)) })
  const a = await book.start({ kind: 'execute', task: 'first', files: [] })
  const b = await book.start({ kind: 'execute', task: 'second', files: [] })
  const c = await book.start({ kind: 'review', task: '', files: [] })
  await pause(5)
  expect(a.status).toBe('working')
  expect(b.status).toBe('queued')
  expect(c.status).toBe('working')
  expect(calls.some(call => call.startsWith('start ct-2'))).toBe(false)
  release()
  await settled(a, b, c)
  expect([a.status, b.status, c.status]).toEqual(['done', 'done', 'done'])
  expect(calls.some(call => call.startsWith('start ct-2'))).toBe(true)
})

test('createBook gives a new job the next free name after a reload left agents behind', async () => {
  const { book } = bookWith({ live: ['ct-1', 'ct-2'] })
  const first = await book.start({ kind: 'execute', task: 'x', files: [] })
  expect(first.id).toBe(3)
  expect(first.agent).toBe('ct-3')
  await settled(first)
})

test('createBook titles jobs by task or by review target', async () => {
  const { book } = bookWith({})
  const exec = await book.start({ kind: 'execute', task: 'add the thing', files: [] })
  const review = await book.start({ kind: 'review', task: '', files: [], target: 'main' })
  const bare = await book.start({ kind: 'review', task: '', files: [] })
  expect(exec.title).toBe('add the thing')
  expect(review.title).toBe('review of main')
  expect(bare.title).toBe('review of the current diff')
  await settled(exec, review, bare)
})

test('cancel of a queued job never touches herdr for it and the queue skips it', async () => {
  let release = () => {}
  const { book, calls } = bookWith({ gate: new Promise<void>(done => (release = done)) })
  const a = await book.start({ kind: 'execute', task: 'first', files: [] })
  const b = await book.start({ kind: 'execute', task: 'second', files: [] })
  expect(await book.cancel(b.id)).toContain('cancelled')
  expect(b.status).toBe('cancelled')
  release()
  await settled(a)
  await pause(5)
  expect(b.status).toBe('cancelled')
  expect(calls.some(call => call.includes('ct-2'))).toBe(false)
})

test('cancel of a working job sends Esc, keeps the pane and stays cancelled without a finished message', async () => {
  let release = () => {}
  const { book, calls, events } = bookWith({ gate: new Promise<void>(done => (release = done)) })
  const a = await book.start({ kind: 'execute', task: 'long', files: [] })
  await pause(5)
  expect(await book.cancel(a.id)).toContain('Esc')
  expect(calls).toContain('keys ct-1 esc')
  expect(a.status).toBe('cancelled')
  release()
  await pause(10)
  expect(a.status).toBe('cancelled')
  expect(events).toEqual([])
  expect(calls.some(call => call.includes('close'))).toBe(false)
})

test('cancel answers for a finished job and for an unknown id', async () => {
  const { book } = bookWith({})
  const a = await book.start({ kind: 'review', task: '', files: [] })
  await settled(a)
  expect(await book.cancel(a.id)).toContain('nothing to cancel')
  expect(await book.cancel(99)).toContain('No job ct-99')
})

test('jobsReport lists newest first with the report path, and says so when empty', async () => {
  const { book } = bookWith({})
  expect(jobsReport([], 0)).toBe('No Codex Team jobs in this session.')
  const a = await book.start({ kind: 'execute', task: 'first task', files: [] })
  await settled(a)
  const b = await book.start({ kind: 'review', task: '', files: [] })
  await settled(b)
  const lines = jobsReport(book.jobs(), 0).split('\n')
  expect(lines[0]).toContain('ct-2 review done')
  expect(jobsReport(book.jobs(), 0)).toContain('report /tmp/codex-team/1.md')
  expect(jobDetail(a)).toContain('pane: w1:p2')
  expect(jobDetail(a)).toContain('report text')
})

test('orphans lists live ct agents that no job of this session owns', async () => {
  const { book } = bookWith({ live: ['ct-7'] })
  expect(await book.orphans()).toEqual([{ name: 'ct-7', pane: 'w9:p9' }])
})

test('book.done resolves after done and failed jobs, including after they settled', async () => {
  const { book } = bookWith({ prompt: ['idle', new Error('failed prompt')] })
  const a = await book.start(request())
  const b = await book.start(request('review'))
  expect((await book.done(a.id)).status).toBe('done')
  expect((await book.done(b.id)).status).toBe('failed')
  expect(await book.done(a.id)).toBe(a)
})

test('book.done resolves a cancel while queued or working without waiting for the run', async () => {
  let release = () => {}
  const { book } = bookWith({ gate: new Promise<void>(done => (release = done)) })
  const a = await book.start(request())
  const b = await book.start(request())
  await pause(5)
  const waiting = book.done(b.id)
  await book.cancel(b.id)
  expect((await waiting).status).toBe('cancelled')
  await book.cancel(a.id)
  expect((await book.done(a.id)).status).toBe('cancelled')
  release()
})

test('quiet jobs keep blocked notifications and drop only finished notifications', async () => {
  const { book, events } = bookWith({ prompt: ['blocked'], wait: ['idle'] })
  const a = await book.start(request(), { quiet: true })
  await book.done(a.id)
  expect(events).toEqual(['blocked ct-1 blocked'])
})

test('exclusive holds plain executes back while owned execute jobs run inside it', async () => {
  let release = () => {}
  const gate = new Promise<void>(done => (release = done))
  const { book, calls } = bookWith({})
  let child: Job | undefined
  const exclusive = book.exclusive(async () => {
    child = await book.start(request(), { owned: true })
    await book.done(child.id)
    await gate
  })
  await pause(5)
  expect(child?.status).toBe('done')
  const other = await book.start(request())
  await pause(5)
  expect(other.status).toBe('queued')
  expect(calls.filter(call => call.startsWith('start')).length).toBe(1)
  release()
  await exclusive
  expect((await book.done(other.id)).status).toBe('done')
})

test('reserveId shares the counter with start and skips live agent names', async () => {
  const { book } = bookWith({ live: ['ct-1'] })
  expect(await book.reserveId()).toBe(2)
  const [a, b] = await Promise.all([book.start(request()), book.start(request('review'))])
  expect([a.id, b.id]).toEqual([3, 4])
  await Promise.all([book.done(a.id), book.done(b.id)])
})
