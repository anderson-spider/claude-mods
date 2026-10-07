import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { agentName, nextFreeId, reportPath } from '../hooks/names'
import { buildPrompt, codexArgs } from '../hooks/prompts'
import { requestOf } from '../hooks/requests'
import { splitDirection } from '../hooks/job'

test('agentName prefixes the job id', () => {
  expect(agentName(3)).toBe('ct-3')
})

test('nextFreeId skips the names that are still live agents', () => {
  expect(nextFreeId(1, ['ct-1', 'ct-2', 'other'])).toBe(3)
  expect(nextFreeId(1, [])).toBe(1)
})

test('codexArgs sandboxes execute to the workspace and review to read-only', () => {
  expect(codexArgs('execute')).toEqual(['-s', 'workspace-write', '-a', 'on-request'])
  expect(codexArgs('review')).toEqual(['-s', 'read-only', '-a', 'on-request'])
})

test('splitDirection goes right on a wide pane and down otherwise', () => {
  expect(splitDirection({ width: 286, height: 71 })).toBe('right')
  expect(splitDirection({ width: 80, height: 60 })).toBe('down')
})

test('reportPath lives in a codex-team folder of TMPDIR, falling back to /tmp', () => {
  expect(reportPath('/var/tmp', 4)).toBe('/var/tmp/codex-team/4.md')
  expect(reportPath('/var/tmp/', 4)).toBe('/var/tmp/codex-team/4.md')
  expect(reportPath(undefined, 4)).toBe('/tmp/codex-team/4.md')
})

test('buildPrompt for execute carries the task, the files, the report path and the no-commit rule', () => {
  const prompt = buildPrompt('execute', { task: 'add X', files: ['a.ts'] }, '/tmp/codex-team/1.md')
  expect(prompt).toContain('add X')
  expect(prompt).toContain('a.ts')
  expect(prompt).toContain('/tmp/codex-team/1.md')
  expect(prompt).toContain('Do not commit')
  expect(prompt).toContain('answer with only that path')
})

test('buildPrompt for review carries the target and focus and forbids edits', () => {
  const prompt = buildPrompt('review', { target: 'main', focus: 'races' }, '/tmp/codex-team/2.md')
  expect(prompt).toContain('main')
  expect(prompt).toContain('races')
  expect(prompt).toContain('Do not edit any file')
  expect(prompt).toContain('/tmp/codex-team/2.md')
  expect(prompt).toContain('answer with only that path')
})

test('requestOf rejects an empty task and trims the valid ones', () => {
  expect(typeof requestOf('execute', {})).toBe('string')
  expect(typeof requestOf('execute', { task: '  ' })).toBe('string')
  expect(requestOf('execute', { task: ' t ', files: ['a', 3, ''] })).toEqual({ kind: 'execute', task: 't', files: ['a'] })
  expect(requestOf('review', {})).toEqual({ kind: 'review', task: '', files: [] })
})

import { fixTask, qaFocus } from '../hooks/prompts'
import { loopOf } from '../hooks/requests'
import { verdictOf } from '../hooks/loop'

test('verdictOf accepts only the exact last non-empty line', () => {
  expect(verdictOf('findings\nVERDICT: APPROVED')).toBe('approved')
  expect(verdictOf('findings\n  VERDICT: CHANGES  \n\n  ')).toBe('changes')
  expect(verdictOf('findings\r\n VERDICT: APPROVED \r\n')).toBe('approved')
  for (const report of [undefined, '', '  \n', 'verdict: approved', 'VERDICT: approved', 'VERDICT: APPROVED extra', 'VERDICT: APPROVED\nmore text']) {
    expect(verdictOf(report)).toBe(undefined)
  }
})

test('qaFocus uses the task as acceptance criteria and ends with the exact verdict rule', () => {
  const focus = qaFocus('add X and check Y')
  expect(focus).toContain('Acceptance criteria:\nadd X and check Y')
  expect(focus).toContain('actionable findings')
  expect(focus).toContain('Do not edit any file')
  expect(focus.endsWith('End the report with exactly one last line: VERDICT: APPROVED or VERDICT: CHANGES.')).toBe(true)
})

test('fixTask carries the original task and the previous QA report path', () => {
  const task = fixTask('add X', '/tmp/codex-team/3.md')
  expect(task).toContain('add X')
  expect(task).toContain('/tmp/codex-team/3.md')
  expect(task).toContain('fix the findings')
})

test('loopOf requires a task, trims files and defaults maxRounds to three', () => {
  expect(typeof loopOf({})).toBe('string')
  expect(typeof loopOf({ task: '  ' })).toBe('string')
  expect(loopOf({ task: ' add X ', files: [' a.ts ', '', 4] })).toEqual({ task: 'add X', files: ['a.ts'], maxRounds: 3 })
  expect(loopOf({ task: 'add X', maxRounds: 1 })).toEqual({ task: 'add X', files: [], maxRounds: 1 })
})

test('loopOf rejects maxRounds unless it is an integer at least one', () => {
  for (const maxRounds of [0, -1, 1.5, '3', null, true, NaN, Infinity]) {
    expect(loopOf({ task: 'add X', maxRounds })).toBe('Give maxRounds as an integer at least 1.')
  }
})

// --- Job lifecycle, against a scripted Herdr ---

import { HerdrError } from '../hooks/model'
import { runJob } from '../hooks/job'
import type { AgentState, Deps, Herdr, Job, Request, Settled } from '../hooks/model'

type Script = { prompt?: (Settled | Error)[]; wait?: (AgentState | Error)[]; start?: Error; read?: string; onPrompt?: () => void; live?: string[]; gate?: Promise<void> }

function fakeHerdr(script: Script) {
  const calls: string[] = []
  const prompts = [...(script.prompt ?? [])]
  const waits = [...(script.wait ?? [])]
  const pop = <T>(queue: (T | Error)[], fallback: T): T => {
    const next = queue.length ? queue.shift()! : fallback
    if (next instanceof Error) throw next
    return next
  }
  const herdr: Herdr = {
    size: async () => {
      calls.push('size')
      return { width: 286, height: 71 }
    },
    split: async direction => {
      calls.push(`split ${direction}`)
      return 'w1:p2'
    },
    start: async (name, pane, args) => {
      calls.push(`start ${name} ${pane} ${args.join(' ')}`)
      if (script.start) throw script.start
    },
    prompt: async (name, text) => {
      calls.push(`prompt ${name}`)
      script.onPrompt?.()
      await script.gate
      return pop<Settled>(prompts, 'idle')
    },
    wait: async (name, _timeoutMs, until) => {
      calls.push(`wait ${name}${until ? ` until ${until.join('|')}` : ''}`)
      return pop<AgentState>(waits, 'idle')
    },
    read: async () => {
      calls.push('read')
      return script.read ?? 'pane text'
    },
    sendKeys: async (name, keys) => {
      calls.push(`keys ${name} ${keys.join(' ')}`)
    },
    list: async () => (script.live ?? []).map(name => ({ name, pane: 'w9:p9' })),
  }
  return { herdr, calls }
}

const job = (kind: 'execute' | 'review' = 'execute', id = 1): Job => ({ id, kind, title: 't', status: 'queued', agent: `ct-${id}`, startedAt: 0 })
const request = (kind: 'execute' | 'review' = 'execute'): Request => ({ kind, task: 'do it', files: [] })

function setup(script: Script, files: Record<string, string> = { '/tmp/codex-team/1.md': '# Report\nall done' }) {
  const { herdr, calls } = fakeHerdr(script)
  const events: string[] = []
  let clock = 0
  const deps: Deps = {
    herdr,
    files: { read: async path => files[path], write: async () => {} },
    tmpdir: undefined,
    now: () => clock,
    notify: (event, j) => events.push(`${event} ${j.status}`),
  }
  return { deps, calls, events, advance: (ms: number) => (clock += ms) }
}

test('runJob runs an execute job to done with its report', async () => {
  const { deps, calls, events } = setup({})
  const j = job()
  await runJob(deps, j, request())
  expect(calls).toEqual(['size', 'split right', 'start ct-1 w1:p2 -s workspace-write -a on-request', 'prompt ct-1'])
  expect(j.status).toBe('done')
  expect(j.pane).toBe('w1:p2')
  expect(j.report).toBe('/tmp/codex-team/1.md')
  expect(j.summary).toContain('all done')
  expect(events).toEqual(['finished done'])
})

test('runJob starts a review job read-only', async () => {
  const { deps, calls } = setup({}, { '/tmp/codex-team/1.md': 'findings' })
  await runJob(deps, job('review'), request('review'))
  expect(calls[2]).toBe('start ct-1 w1:p2 -s read-only -a on-request')
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

// --- The job book: ids, the execute queue, cancel and reports ---

import { createBook } from '../hooks/book'
import { jobDetail, jobsReport } from '../hooks/presentation'

declare const setTimeout: (fn: () => void, ms: number) => unknown
const pause = (ms: number) => new Promise<void>(done => setTimeout(() => done(), ms))
const over = (j: Job) => ['done', 'failed', 'cancelled'].includes(j.status)
const settled = async (...jobs: Job[]) => {
  for (let i = 0; i < 100 && !jobs.every(over); i++) await pause(1)
}

function bookWith(script: Script) {
  const { herdr, calls } = fakeHerdr(script)
  const events: string[] = []
  const book = createBook({
    herdr,
    files: { read: async () => 'report text', write: async () => {} },
    tmpdir: undefined,
    now: () => 0,
    notify: (event, j) => events.push(`${event} ${j.agent} ${j.status}`),
  })
  return { book, calls, events }
}

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

test('cancel of a working job sends ctrl+c, keeps the pane and stays cancelled without a finished message', async () => {
  let release = () => {}
  const { book, calls, events } = bookWith({ gate: new Promise<void>(done => (release = done)) })
  const a = await book.start({ kind: 'execute', task: 'long', files: [] })
  await pause(5)
  expect(await book.cancel(a.id)).toContain('ctrl+c')
  expect(calls).toContain('keys ct-1 ctrl+c')
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

// --- Dev and QA rounds, using the real book and scripted reports ---

import { cancelLoop, loopStart, runLoop } from '../hooks/loop'
import { loopReport } from '../hooks/presentation'
import type { Loop } from '../hooks/model'

function loopWith(reports: (string | undefined)[], script: Script = {}, gates: Record<number, Promise<void>> = {}) {
  const { herdr, calls } = fakeHerdr(script)
  const files: Record<string, string> = {}
  const prompts: string[] = []
  const events: string[] = []
  const prompt = herdr.prompt
  herdr.prompt = async (name, text, timeout) => {
    const index = prompts.length
    prompts.push(text)
    const report = reports[index]
    if (report !== undefined) files[reportPath(undefined, Number(name.slice(3)))] = report
    await gates[index]
    return prompt(name, text, timeout)
  }
  const deps = {
    herdr,
    files: { read: async (path: string) => files[path], write: async (path: string, text: string) => { files[path] = text } },
    tmpdir: undefined,
    now: () => 0,
    notify: (_event: 'finished', loop: Loop) => { events.push(`loop ${loop.id} ${loop.status}`) },
  }
  const book = createBook({ ...deps, notify: (event, job) => { events.push(`${event} ${job.agent}`) } })
  const finished = async (loop: Loop) => {
    for (let i = 0; i < 100 && !events.some(event => event.startsWith(`loop ${loop.id} `)); i++) await pause(1)
    expect(events.some(event => event.startsWith(`loop ${loop.id} `))).toBe(true)
  }
  return { deps, book, calls, files, prompts, events, finished }
}

const loopRequest = (maxRounds = 3) => ({ task: 'add X', files: ['a.ts'], maxRounds })

test('loop approves after one dev and QA and notifies only once', async () => {
  const state = loopWith(['dev report', 'A finding above the verdict\nVERDICT: APPROVED'])
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(loop.rounds).toEqual([{ dev: 2, qa: 3, verdict: 'approved' }])
  expect(state.events).toEqual(['loop 1 approved'])
  expect(state.prompts[0]).toContain('a.ts')
  expect(state.prompts[1]).toContain(qaFocus('add X'))
  expect(loop.report).toBe('/tmp/codex-team/loop-1.md')
  expect(state.files[loop.report!]).toContain('ct-2')
  expect(state.files[loop.report!]).toContain('/tmp/codex-team/3.md')
})

test('loop sends changes back to dev with the original task and the QA report path', async () => {
  const state = loopWith(['dev', 'fix this\nVERDICT: CHANGES', 'fixed', 'VERDICT: APPROVED'])
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(loop.rounds).toEqual([{ dev: 2, qa: 3, verdict: 'changes' }, { dev: 4, qa: 5, verdict: 'approved' }])
  expect(state.prompts[2]).toContain(fixTask('add X', '/tmp/codex-team/3.md'))
  expect(state.events).toEqual(['loop 1 approved'])
})

test('loop exhausts maxRounds and writes the last QA findings', async () => {
  const state = loopWith(['dev', 'first\nVERDICT: CHANGES', 'dev', 'last actionable finding\nVERDICT: CHANGES'])
  const loop = await loopStart(state.deps, state.book, loopRequest(2))
  await state.finished(loop)
  expect(loop.status).toBe('exhausted')
  expect(state.prompts.length).toBe(4)
  expect(state.files[loop.report!]).toContain('last actionable finding')
  expect(loopReport(loop, state.book)).toContain('2/2')
})

test('loop fails on a missing or invalid QA verdict and names its report path', async () => {
  for (const report of [undefined, '', 'no verdict', 'VERDICT: APPROVED\nextra', 'verdict: approved']) {
    const state = loopWith(['dev', report])
    const loop = await loopStart(state.deps, state.book, loopRequest())
    await state.finished(loop)
    expect(loop.status).toBe('failed')
    expect(loop.error).toContain('QA report has no VERDICT line')
    expect(loop.error).toContain('/tmp/codex-team/3.md')
    expect(state.prompts.length).toBe(2)
  }
})

test('loop fails naming the dev or QA phase and round when a child fails', async () => {
  for (const failureAt of [0, 3]) {
    const script: Script = { prompt: Array.from({ length: failureAt + 1 }, (_, i) => i === failureAt ? new Error('broken') : 'idle') }
    const state = loopWith(['dev', 'VERDICT: CHANGES', 'dev', 'VERDICT: APPROVED'], script)
    const loop = await loopStart(state.deps, state.book, loopRequest())
    await state.finished(loop)
    expect(loop.status).toBe('failed')
    expect(loop.error).toContain(failureAt === 0 ? 'dev 1' : 'qa 2')
    expect(loop.error).toContain('broken')
    expect(state.prompts.length).toBe(failureAt + 1)
  }
})

test('loop reviews a dev with no report and keeps the note', async () => {
  const state = loopWith([undefined, 'VERDICT: APPROVED'])
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(loop.error).toContain('dev 1')
  expect(loop.error).toContain('no report')
})

test('loop children still notify when blocked without finishing messages', async () => {
  const state = loopWith(['dev', 'VERDICT: APPROVED'], { prompt: ['blocked', 'blocked'], wait: ['idle', 'idle'] })
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(state.events).toEqual(['blocked ct-2', 'blocked ct-3', 'loop 1 approved'])
})

test('cancelling a loop during dev or QA cancels the active child and starts nothing more', async () => {
  for (const phase of [0, 1]) {
    let release = () => {}
    const gate = new Promise<void>(done => (release = done))
    const state = loopWith(['dev', 'VERDICT: CHANGES'], {}, { [phase]: gate })
    const loop = await loopStart(state.deps, state.book, loopRequest())
    for (let i = 0; i < 100 && state.prompts.length <= phase; i++) await pause(1)
    expect(loop.status).toBe(phase === 0 ? 'developing' : 'reviewing')
    expect(await cancelLoop(state.deps, state.book, loop)).toContain('cancelled')
    release()
    await state.finished(loop)
    expect(loop.status).toBe('cancelled')
    expect(state.calls).toContain(`keys ct-${phase + 2} ctrl+c`)
    expect(state.prompts.length).toBe(phase + 1)
    expect(state.events).toEqual(['loop 1 cancelled'])
  }
})

test('cancelling the dev keeps another execute queued until its pending prompt settles', async () => {
  for (const parent of [false, true]) {
    let release = () => {}
    const gate = new Promise<void>(done => (release = done))
    const state = loopWith(['dev', 'other'], {}, { 0: gate })
    const loop = await loopStart(state.deps, state.book, loopRequest())
    for (let i = 0; i < 100 && !state.prompts.length; i++) await pause(1)
    expect(state.prompts.length).toBe(1)
    const dev = loop.rounds[0]!.dev
    if (parent) await cancelLoop(state.deps, state.book, loop)
    else await state.book.cancel(dev)
    expect((await state.book.done(dev)).status).toBe('cancelled')
    const other = await state.book.start({ kind: 'execute', task: 'unrelated', files: [] })
    try {
      await pause(5)
      expect(other.status).toBe('queued')
      expect(state.prompts.length).toBe(1)
    } finally {
      release()
    }
    await state.finished(loop)
    expect((await state.book.done(other.id)).status).toBe('done')
    expect(loop.status).toBe('cancelled')
    expect(state.prompts.length).toBe(2)
    expect(state.prompts[1]).toContain('unrelated')
  }
})

test('a failed ctrl+c can be retried without releasing the dev slot before its prompt settles', async () => {
  let release = () => {}
  const gate = new Promise<void>(done => (release = done))
  const state = loopWith(['dev', 'other'], {}, { 0: gate })
  const sendKeys = state.deps.herdr.sendKeys
  let attempts = 0
  state.deps.herdr.sendKeys = async (...args) => {
    attempts++
    if (attempts === 1) throw new Error('transport failed')
    await sendKeys(...args)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  for (let i = 0; i < 100 && !state.prompts.length; i++) await pause(1)
  expect(state.prompts.length).toBe(1)
  const dev = loop.rounds[0]!.dev
  let ended = false
  void state.book.ended(dev).then(() => { ended = true })
  try {
    expect(await state.book.cancel(dev)).toContain('transport failed')
    expect((await state.book.done(dev)).status).toBe('cancelled')
    expect(await state.book.cancel(dev)).toContain('Sent ctrl+c')
    expect(attempts).toBe(2)
    expect((await state.book.done(dev)).status).toBe('cancelled')
    const other = await state.book.start({ kind: 'execute', task: 'unrelated', files: [] })
    await pause(5)
    expect(ended).toBe(false)
    expect(other.status).toBe('queued')
    expect(state.prompts.length).toBe(1)
    release()
    await state.book.ended(dev)
    await state.finished(loop)
    expect((await state.book.done(other.id)).status).toBe('done')
    expect(loop.status).toBe('cancelled')
    expect(state.prompts.length).toBe(2)
    expect(state.prompts[1]).toContain('unrelated')
    expect(await state.book.cancel(dev)).toContain('nothing to cancel')
    expect(attempts).toBe(2)
  } finally {
    release()
  }
})

test('loop holds one exclusive slot across every dev and QA round', async () => {
  let release = () => {}
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'dev', 'VERDICT: APPROVED', 'other'], {}, { 1: new Promise<void>(done => (release = done)) })
  let slots = 0
  const exclusive = state.book.exclusive
  state.book.exclusive = task => { slots++; return exclusive(task) }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  for (let i = 0; i < 100 && state.prompts.length < 2; i++) await pause(1)
  const other = await state.book.start({ kind: 'execute', task: 'unrelated', files: [] })
  await pause(5)
  expect(other.status).toBe('queued')
  release()
  await state.finished(loop)
  await state.book.done(other.id)
  expect(slots).toBe(1)
  expect(state.prompts[2]).toContain('fix the findings')
  expect(state.prompts[3]).toContain('Acceptance criteria')
  expect(state.prompts[4]).toContain('unrelated')
})

test('runLoop never rejects if the queue or report write fails', async () => {
  for (const phase of ['queue', 'write']) {
    const state = loopWith(['dev', 'VERDICT: APPROVED'])
    if (phase === 'queue') state.book.exclusive = async () => { throw new Error('queue broken') }
    else state.deps.files.write = async () => { throw new Error('write broken') }
    const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
    await runLoop(state.deps, loop, state.book)
    expect(loop.status).toBe('failed')
    expect(loop.error).toContain(`${phase} broken`)
    expect(state.events).toEqual(['loop 1 failed'])
  }
})

test('a loop cancelled while its child starts never sends that child a task afterwards', async () => {
  for (const phase of [0, 1]) {
    for (const notReady of [false, true]) {
      for (const missing of [false, true]) {
        let release = () => {}
        let starting = false
        const gate = new Promise<void>(done => (release = done))
        const state = loopWith(['dev', 'VERDICT: APPROVED'])
        const start = state.deps.herdr.start
        state.deps.herdr.start = async (...args) => {
          if (args[0] !== `ct-${phase + 2}`) return start(...args)
          starting = true
          await gate
          if (notReady) throw new HerdrError('agent_not_ready', 'agent is still starting')
          await start(...args)
        }
        if (missing) state.deps.herdr.sendKeys = async () => { throw new HerdrError('agent_not_found', 'agent is still starting') }
        const loop = await loopStart(state.deps, state.book, loopRequest())
        for (let i = 0; i < 100 && !starting; i++) await pause(1)
        expect(starting).toBe(true)
        await cancelLoop(state.deps, state.book, loop)
        const child = phase === 0 ? loop.rounds[0]!.dev : loop.rounds[0]!.qa!
        const other = await state.book.start({ kind: 'execute', task: 'unrelated', files: [] })
        expect(other.status).toBe('queued')
        release()
        await state.book.ended(child)
        await state.finished(loop)
        expect((await state.book.done(other.id)).status).toBe('done')
        expect(loop.status).toBe('cancelled')
        expect(state.calls.some(call => call.startsWith(`wait ct-${child}`))).toBe(false)
        expect(state.calls.some(call => call.startsWith(`prompt ct-${child}`))).toBe(false)
        expect(state.prompts.length).toBe(phase + 1)
        expect(state.prompts[phase]).toContain('unrelated')
      }
    }
  }
})

test('loop children cannot reuse a previous report when the new job writes none', async () => {
  const state = loopWith([undefined, undefined])
  state.files['/tmp/codex-team/2.md'] = 'old dev report'
  state.files['/tmp/codex-team/3.md'] = 'old QA report\nVERDICT: APPROVED'
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('failed')
  expect(loop.error).toContain('dev 1')
  expect(loop.error).toContain('no report')
  expect(loop.error).toContain('QA report has no VERDICT line: /tmp/codex-team/3.md')
  expect(state.book.get(3)?.report).toBe(undefined)
})

test('loop fails before starting a child if its old report cannot be invalidated', async () => {
  const state = loopWith(['dev', 'VERDICT: APPROVED'])
  const write = state.deps.files.write
  state.deps.files.write = async (path, text) => {
    if (path === '/tmp/codex-team/2.md') throw new Error('cannot prepare report')
    await write(path, text)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('failed')
  expect(loop.error).toContain('dev 1')
  expect(loop.error).toContain('cannot prepare report')
  expect(state.calls.some(call => call.startsWith('start '))).toBe(false)
})

// --- The Herdr adapter over the CLI ---

import { herdrAvailable, herdrOf } from '../hooks/herdr'
import type { Run } from '../hooks/model'

type Answer = { exitCode?: number; stdout?: string; stderr?: string }

// A fake `run` that records argv and answers by the herdr subcommand ("pane layout", "agent wait", …).
function fakeRun(answers: Record<string, Answer>) {
  const argvs: string[][] = []
  const timeouts: (number | undefined)[] = []
  const run: Run = async (argv, init) => {
    argvs.push(argv)
    timeouts.push(init?.timeoutMs)
    const key = argv[0] === 'herdr' && argv.length > 2 ? `${argv[1]} ${argv[2]}` : argv[0]!
    const answer = answers[key] ?? { stdout: '{}' }
    return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return { run, argvs, timeouts }
}

const agent = (status: string) => JSON.stringify({ result: { agent: { agent_status: status, name: 'ct-1', pane_id: 'w1:p2' } } })
const adapter = (answers: Record<string, Answer>) => {
  const fake = fakeRun(answers)
  return { ...fake, herdr: herdrOf(fake.run, { pane: 'w1:p1', cwd: '/proj' }) }
}

test('herdrOf passes a prompt with quotes, newlines and $() as exactly one argv element', async () => {
  const { herdr, argvs } = adapter({ 'agent prompt': { stdout: agent('done') } })
  const text = 'a "b"\n`c` $(d) \'e\''
  expect(await herdr.prompt('ct-1', text, 1000)).toBe('done')
  const argv = argvs.find(a => a[2] === 'prompt')!
  expect(argv).toEqual(['herdr', 'agent', 'prompt', 'ct-1', text, '--wait', '--timeout', '1000'])
})

test('herdrOf gives the process room beyond the herdr wait it asks for', async () => {
  const { herdr, timeouts } = adapter({ 'agent prompt': { stdout: agent('idle') }, 'agent wait': { stdout: agent('blocked') } })
  await herdr.prompt('ct-1', 'x', 540_000)
  expect(timeouts[0]).toBe(560_000)
  expect(await herdr.wait('ct-1', 1000)).toBe('blocked')
  expect(timeouts[1]).toBe(21_000)
})

test('herdrOf splits the given pane without focus, in the given directory', async () => {
  const { herdr, argvs } = adapter({ 'pane split': { stdout: JSON.stringify({ result: { pane: { pane_id: 'w1:p2' } } }) } })
  expect(await herdr.split('right')).toBe('w1:p2')
  expect(argvs[0]).toEqual(['herdr', 'pane', 'split', 'w1:p1', '--direction', 'right', '--cwd', '/proj', '--no-focus'])
})

test('herdrOf reads the size of the pane from its layout', async () => {
  const { herdr, argvs } = adapter({ 'pane layout': { stdout: JSON.stringify({ result: { layout: { area: { width: 286, height: 71 } } } }) } })
  expect(await herdr.size()).toEqual({ width: 286, height: 71 })
  expect(argvs[0]).toEqual(['herdr', 'pane', 'layout', '--pane', 'w1:p1'])
})

test('herdrOf starts Codex with its own arguments after --', async () => {
  const { herdr, argvs } = adapter({})
  await herdr.start('ct-1', 'w1:p2', ['-s', 'read-only', '-a', 'on-request'])
  expect(argvs[0]).toEqual(['herdr', 'agent', 'start', 'ct-1', '--kind', 'codex', '--pane', 'w1:p2', '--', '-s', 'read-only', '-a', 'on-request'])
})

test('herdrOf waits until the given states and sends keys', async () => {
  const { herdr, argvs } = adapter({ 'agent wait': { stdout: agent('working') } })
  expect(await herdr.wait('ct-1', 5000, ['working', 'idle'])).toBe('working')
  expect(argvs[0]).toEqual(['herdr', 'agent', 'wait', 'ct-1', '--timeout', '5000', '--until', 'working', '--until', 'idle'])
  await herdr.sendKeys('ct-1', ['ctrl+c'])
  expect(argvs[1]).toEqual(['herdr', 'agent', 'send-keys', 'ct-1', 'ctrl+c'])
})

test('herdrOf reads the pane text raw and lists only ct agents', async () => {
  const listed = JSON.stringify({ result: { agents: [{ agent: 'claude', pane_id: 'w1:p1' }, { agent: 'codex', name: 'ct-2', pane_id: 'w1:p3' }, { agent: 'codex', name: 'other', pane_id: 'w1:p4' }] } })
  const { herdr, argvs } = adapter({ 'agent read': { stdout: 'line 1\nline 2\n' }, 'agent list': { stdout: listed } })
  expect(await herdr.read('ct-1', 50)).toBe('line 1\nline 2\n')
  expect(argvs[0]).toEqual(['herdr', 'agent', 'read', 'ct-1', '--source', 'recent-unwrapped', '--lines', '50'])
  expect(await herdr.list()).toEqual([{ name: 'ct-2', pane: 'w1:p3' }])
})

test('herdrOf turns a CLI error into a HerdrError with its code', async () => {
  const { herdr } = adapter({ 'agent start': { exitCode: 1, stderr: '{"error":{"code":"agent_not_ready","message":"blocked at startup"},"id":"x"}' }, 'agent wait': { exitCode: 1, stdout: 'not json at all' } })
  const started = await herdr.start('ct-1', 'w1:p2', []).catch(e => e)
  expect(started).toBeInstanceOf(HerdrError)
  expect((started as HerdrError).code).toBe('agent_not_ready')
  expect((started as HerdrError).message).toContain('blocked at startup')
  const waited = await herdr.wait('ct-1', 1000).catch(e => e)
  expect((waited as HerdrError).code).toBe('unknown')
  expect((waited as HerdrError).message).toContain('not json at all')
})

test('herdrOf refuses a prompt answer that is not a settled state', async () => {
  const { herdr } = adapter({ 'agent prompt': { stdout: agent('working') } })
  const error = await herdr.prompt('ct-1', 'x', 1000).catch(e => e)
  expect(error).toBeInstanceOf(HerdrError)
})

test('herdrAvailable says why the plugin cannot run', async () => {
  expect(await herdrAvailable(fakeRun({}).run, {})).toContain('Herdr')
  expect(await herdrAvailable(fakeRun({ herdr: { exitCode: 127 } }).run, { HERDR_ENV: '1' })).toContain('herdr')
  expect(await herdrAvailable(fakeRun({ codex: { exitCode: 127 } }).run, { HERDR_ENV: '1' })).toContain('codex')
  expect(await herdrAvailable(fakeRun({}).run, { HERDR_ENV: '1' })).toBeUndefined()
})

// --- The band and the prompt section ---

import { PROMPT } from '../hooks/prompts'
import { bandRows, doctorReport } from '../hooks/presentation'
import type { BandJob } from '../types'

const band = (id: string, status: BandJob['status'], elapsedSeconds: number, pane = 'w1:p2'): BandJob => ({ id, kind: 'execute', status, pane, elapsedSeconds })

test('bandRows draws one row per job with its status, elapsed time and pane', () => {
  const { rows, hidden } = bandRows([band('ct-1', 'working', 130)], 5)
  expect(rows).toEqual(['ct-1 execute  working  2m10s  w1:p2'])
  expect(hidden).toBe(0)
})

test('bandRows pads the seconds and points a blocked job to its pane', () => {
  expect(bandRows([band('ct-4', 'working', 605)], 5).rows[0]).toContain('10m05s')
  expect(bandRows([band('ct-4', 'working', 45)], 5).rows[0]).toContain('0m45s')
  expect(bandRows([band('ct-4', 'blocked', 45, 'w1:p3')], 5).rows[0]).toBe('ct-4 execute  blocked  0m45s  w1:p3  ← answer in the pane')
})

test('bandRows caps the rows at the room and counts the rest as hidden', () => {
  const jobs = [band('ct-1', 'working', 1), band('ct-2', 'working', 2), band('ct-3', 'working', 3)]
  const { rows, hidden } = bandRows(jobs, 2)
  expect(rows.length).toBe(2)
  expect(hidden).toBe(1)
  expect(bandRows(jobs, 0)).toEqual({ rows: [], hidden: 3 })
  expect(bandRows([], 5)).toEqual({ rows: [], hidden: 0 })
})

test('PROMPT teaches Claude to lead: execute, review, the report and the queue', () => {
  expect(PROMPT).toContain('mcp__codex-team__execute')
  expect(PROMPT).toContain('mcp__codex-team__review')
  expect(PROMPT).toContain('report')
  expect(PROMPT).toContain('second')
  expect(PROMPT).toContain('mcp__codex-team__loop')
  expect(PROMPT).toContain('maxRounds')
  expect(PROMPT).toContain('one message at the end with a verdict')
})

test('bandRows draws the loop phase and round without changing job rows', () => {
  const loop: BandJob = { id: 'loop-1', kind: 'loop', status: 'reviewing', round: 2, maxRounds: 3, pane: '…', elapsedSeconds: 10 }
  const { rows } = bandRows([loop, band('ct-4', 'working', 10)], 2)
  expect(rows[0]).toContain('loop-1 reviewing 2/3')
  expect(rows[1]).toBe('ct-4 execute  working  0m10s  w1:p2')
})

test('doctorReport marks each check and counts the failures', () => {
  const text = doctorReport([
    { name: 'herdr', ok: true, detail: 'herdr 0.9.3' },
    { name: 'codex', ok: false, detail: 'not in PATH' },
  ])
  expect(text).toContain('✓ herdr: herdr 0.9.3')
  expect(text).toContain('✗ codex: not in PATH')
  expect(text).toContain('1 check(s) failed.')
  expect(doctorReport([{ name: 'herdr', ok: true, detail: 'ok' }])).toContain('Everything codex-team relies on is in place.')
})

// --- Tool wiring against the engine, with no host processes or files ---

function loopHost(on: On, gate?: Promise<void>) {
  const clock = mock.clock(on)
  mock.env(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', TMPDIR: '/tmp' })
  const tools: Record<string, unknown> = {}
  const files: Record<string, string> = {}
  const messages: string[] = []
  const argvs: string[][] = []
  let rows: BandJob[] = []
  let version = 0
  let prompts = 0
  on('tool.register', (_$, e) => { tools[e.name] = e.inputSchema; return { value: { tool: `mcp__codex-team__${e.name}` } } })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('state.get', () => ({ value: { value: rows, version } }))
  on('state.set', (_$, e) => { rows = e.value as BandJob[]; return { value: { isSet: true as const, version: ++version } } })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => { messages.push(e.text); return { text: e.text } })
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => { files[e.path] = e.text; return { value: undefined } })
  on('process.run', async (_$, e) => {
    argvs.push([...e.argv])
    const argv = e.argv
    let stdout = '{}'
    if (argv[1] === '--version') stdout = 'installed'
    if (argv[1] === 'pane' && argv[2] === 'layout') stdout = JSON.stringify({ result: { layout: { area: { width: 286, height: 71 } } } })
    if (argv[1] === 'pane' && argv[2] === 'split') stdout = JSON.stringify({ result: { pane: { pane_id: 'w1:p2' } } })
    if (argv[1] === 'agent' && argv[2] === 'list') stdout = JSON.stringify({ result: { agents: [] } })
    if (argv[1] === 'agent' && argv[2] === 'prompt') {
      const index = prompts++
      files[`/tmp/codex-team/${argv[3]!.slice(3)}.md`] = index === 0 ? 'dev report' : 'VERDICT: APPROVED'
      if (index === 1) await gate
      stdout = agent('done')
    }
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  return { tools, files, messages, argvs, clock, rows: () => rows, prompts: () => prompts }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

test('loop tool registers its schema, lists the parent and publishes one final report', async ($, on) => {
  const host = loopHost(on)
  await startSession($)
  expect(host.tools.loop).toEqual({
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The whole task, self-contained.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Optional files or folders Codex should start from.' },
      maxRounds: { type: 'integer', minimum: 1, default: 3, description: 'Maximum dev and QA rounds.' },
    },
    required: ['task'],
  })
  const answer = await $.tool.call({ tool: 'mcp__codex-team__loop', task: 'add X' })
  expect(answer.result).toContain('Started loop-1')
  for (let i = 0; i < 100 && !host.messages.length; i++) await pause(1)
  expect(host.messages.length).toBe(1)
  expect(host.messages[0]).toContain('loop-1 approved')
  expect(host.messages[0]).toContain('Rounds: 1/3')
  expect(host.messages[0]).toContain('/tmp/codex-team/loop-1.md')
  expect(host.files['/tmp/codex-team/loop-1.md']).toContain('Status: approved')
  expect((await $.tool.call({ tool: 'mcp__codex-team__jobs' })).result).toContain('loop-1 approved 1/3')
  expect((await $.tool.call({ tool: 'mcp__codex-team__jobs', id: 1 })).result).toContain('QA: ct-3')
  expect((await $.command.run({ command: 'codex-team', args: '' })).text).toContain('loop-1 approved 1/3')
  expect((await $.tool.call({ tool: 'mcp__codex-team__jobs', id: 1, action: 'cancel' })).result).toContain('nothing to cancel')
})

test('jobs cancels an active loop by its shared id and the band includes its round', async ($, on) => {
  let release = () => {}
  const host = loopHost(on, new Promise<void>(done => (release = done)))
  await startSession($)
  await $.tool.call({ tool: 'mcp__codex-team__loop', task: 'add X', maxRounds: 2 })
  for (let i = 0; i < 100 && host.prompts() < 2; i++) await pause(1)
  await host.clock.advance(1000)
  expect(host.rows()).toContainEqual(expect.objectContaining({ id: 'loop-1', kind: 'loop', status: 'reviewing', round: 1, maxRounds: 2 }))
  const answer = await $.tool.call({ tool: 'mcp__codex-team__jobs', id: 1, action: 'cancel' })
  expect(answer.result).toContain('cancelled')
  expect(host.argvs.some(argv => argv[2] === 'send-keys' && argv[3] === 'ct-3' && argv[4] === 'ctrl+c')).toBe(true)
  release()
  for (let i = 0; i < 100 && !host.messages.length; i++) await pause(1)
  expect(host.messages.length).toBe(1)
  expect(host.messages[0]).toContain('loop-1 cancelled')
  expect(host.prompts()).toBe(2)
})

test('loop tool rejects invalid inputs before starting a child', async ($, on) => {
  const host = loopHost(on)
  await startSession($)
  const answer = await $.tool.call({ tool: 'mcp__codex-team__loop', task: 'add X', maxRounds: 0 })
  expect(answer.isError).toBe(true)
  expect(answer.result).toContain('integer at least 1')
  expect(host.prompts()).toBe(0)
})
