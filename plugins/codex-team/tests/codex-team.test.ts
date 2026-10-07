import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { agentName, nextFreeId, reportPath } from '../hooks/names'
import { buildPrompt, codexArgs } from '../hooks/prompts'
import { requestOf } from '../hooks/requests'

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
import { createPaneLayout } from '../hooks/pane-layout'
import type { AgentState, Deps, Herdr, Job, Request, Settled } from '../hooks/model'

type Script = { prompt?: (Settled | Error)[]; wait?: (AgentState | Error)[]; start?: Error; rename?: Error; close?: Error; split?: (string | Error)[]; splitGate?: Promise<void>; read?: string; onPrompt?: () => void; live?: string[]; gate?: Promise<void> }

function fakeHerdr(script: Script) {
  const calls: string[] = []
  const prompts = [...(script.prompt ?? [])]
  const waits = [...(script.wait ?? [])]
  const splits = [...(script.split ?? [])]
  let panes = 1
  const pop = <T>(queue: (T | Error)[], fallback: T): T => {
    const next = queue.length ? queue.shift()! : fallback
    if (next instanceof Error) throw next
    return next
  }
  const herdr: Herdr = {
    split: async (direction, target) => {
      calls.push(`split ${direction}${target ? ` ${target}` : ''}`)
      await script.splitGate
      return pop(splits, `w1:p${++panes}`)
    },
    rename: async (pane, name) => {
      calls.push(`rename ${pane} ${name}`)
      if (script.rename) throw script.rename
    },
    close: async pane => {
      calls.push(`close ${pane}`)
      if (script.close) throw script.close
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
    layout: createPaneLayout(),
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

test('jobs share a row below the lead across execute and review', async () => {
  const { deps, calls } = setup({})
  const book = createBook(deps)
  for (const kind of ['execute', 'review', 'execute'] as const) {
    const j = await book.start(request(kind))
    await book.ended(j.id)
    expect(j.status).toBe('done')
  }
  expect(calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2', 'split right w1:p3'])
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
    layout: createPaneLayout(),
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
    if (report !== undefined) files[text.match(/write your final report as Markdown to (.+) and answer/)![1]!] = report
    await gates[index]
    return prompt(name, text, timeout)
  }
  const deps = {
    herdr,
    layout: createPaneLayout(),
    files: { read: async (path: string) => files[path], write: async (path: string, text: string) => { files[path] = text } },
    tmpdir: undefined,
    now: () => 0,
    notify: (event: 'blocked' | 'finished', loop: Loop, job?: Job) => { events.push(event === 'blocked' ? `blocked ${job!.agent}` : `loop ${loop.id} ${loop.status}`) },
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
  expect(state.files[loop.report!]).toContain('ct-1-dev')
  expect(state.files[loop.report!]).toContain('/tmp/codex-team/1-qa1.md')
})

test('finished loops close both role panes after writing the report and notifying', async () => {
  for (const [verdict, status] of [['VERDICT: APPROVED', 'approved'], ['VERDICT: CHANGES', 'exhausted'], ['no verdict', 'failed']]) {
    const state = loopWith(['dev', verdict])
    const close = state.deps.herdr.close
    state.deps.herdr.close = async pane => {
      expect(state.files['/tmp/codex-team/loop-1.md']).toContain(`Status: ${status}`)
      expect(state.events).toEqual([`loop 1 ${status}`])
      await close(pane)
    }
    const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(1), status: 'developing', rounds: [], startedAt: 0 }
    await runLoop(state.deps, loop, state.book)
    expect(loop.status).toBe(status)
    expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2'])
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
  }
})

test('a finished loop clears the last pane so the next job starts below the lead', async () => {
  const state = loopWith(['dev', 'VERDICT: APPROVED', 'next job'])
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(1), status: 'developing', rounds: [], startedAt: 0 }
  await runLoop(state.deps, loop, state.book)
  const next = await state.book.start(request('review'))
  await state.book.ended(next.id)
  expect(next.status).toBe('done')
  expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2', 'split down'])
})

test('a review opening during the last loop pane close waits and then starts below the lead', async () => {
  let closing = false
  let release = () => {}
  const gate = new Promise<void>(done => (release = done))
  const state = loopWith(['dev', 'VERDICT: APPROVED', 'next review'])
  const close = state.deps.herdr.close
  state.deps.herdr.close = async pane => {
    if (pane === 'w1:p3') { closing = true; await gate }
    await close(pane)
  }
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(1), status: 'developing', rounds: [], startedAt: 0 }
  const running = runLoop(state.deps, loop, state.book)
  let next: Job | undefined
  try {
    for (let i = 0; i < 100 && !closing; i++) await pause(1)
    expect(closing).toBe(true)
    next = await state.book.start(request('review'))
    await pause(5)
    expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2'])
  } finally {
    release()
    await running
    if (next) await state.book.ended(next.id)
  }
  expect(next!.status).toBe('done')
  expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2', 'split down'])
})

test('closing older loop panes preserves a newer review as the row target', async () => {
  let release = () => {}
  const state = loopWith(['dev', 'VERDICT: APPROVED', 'other review', 'next review'], {}, { 1: new Promise<void>(done => (release = done)) })
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(1), status: 'developing', rounds: [], startedAt: 0 }
  const running = runLoop(state.deps, loop, state.book)
  try {
    for (let i = 0; i < 100 && state.prompts.length < 2; i++) await pause(1)
    expect(state.prompts.length).toBe(2)
    const review = await state.book.start(request('review'))
    await state.book.ended(review.id)
  } finally {
    release()
    await running
  }
  const next = await state.book.start(request('review'))
  await state.book.ended(next.id)
  expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2', 'split right w1:p3', 'split right w1:p4'])
  expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
})

test('a failed dev closes only its pane and waits until its agent stops', async () => {
  let release = () => {}
  const gate = new Promise<void>(done => (release = done))
  const state = loopWith(['dev'], { prompt: [new Error('prompt failed')] })
  state.deps.herdr.wait = async (name, _timeout, until) => {
    state.calls.push(`wait ${name} until ${until?.join('|')}`)
    await gate
    return 'idle'
  }
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
  const running = runLoop(state.deps, loop, state.book)
  try {
    await state.finished(loop)
    await pause(5)
    expect(loop.status).toBe('failed')
    expect(state.calls).toContain('wait ct-1-dev until idle|done')
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
  } finally { release() }
  await running
  expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2'])
  expect(state.prompts.length).toBe(1)
})

test('a startup timeout waits for the role to stop before closing its pane', async () => {
  let release = () => {}
  const gate = new Promise<void>(done => (release = done))
  const state = loopWith([], { start: new HerdrError('agent_not_ready', 'startup is blocked') })
  let now = 0
  let stopping = false
  state.deps.now = () => now
  state.deps.herdr.wait = async (_name, _timeout, until) => {
    if (until?.includes('working')) {
      now = 30 * 60_000
      throw new HerdrError('timeout', 'still starting')
    }
    stopping = true
    await gate
    return 'idle'
  }
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
  const book = createBook({ ...state.deps, notify: () => {} })
  const running = runLoop(state.deps, loop, book)
  try {
    await state.finished(loop)
    await pause(5)
    expect(loop.status).toBe('failed')
    expect(stopping).toBe(true)
    expect(state.prompts).toEqual([])
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
  } finally { release() }
  await running
  expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2'])
})

test('a close failure preserves every loop outcome and its final notification', async () => {
  for (const [verdict, status] of [['VERDICT: APPROVED', 'approved'], ['VERDICT: CHANGES', 'exhausted'], ['no verdict', 'failed']]) {
    const state = loopWith(['dev', verdict], { close: new Error('cannot close') })
    const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(1), status: 'developing', rounds: [], startedAt: 0 }
    await runLoop(state.deps, loop, state.book)
    expect(loop.status).toBe(status)
    expect(loop.error).not.toContain('cannot close')
    expect(state.events).toEqual([`loop 1 ${status}`])
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
  }
})

test('a cancelled loop still notifies and attempts both closes when closing fails', async () => {
  let release = () => {}
  const state = loopWith(['dev', 'VERDICT: APPROVED'], { close: new Error('cannot close') }, { 1: new Promise<void>(done => (release = done)) })
  const close = state.deps.herdr.close
  state.deps.herdr.close = async pane => {
    expect(state.files['/tmp/codex-team/loop-1.md']).toContain('Status: cancelled')
    expect(state.events).toEqual(['loop 1 cancelled'])
    await close(pane)
  }
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
  const running = runLoop(state.deps, loop, state.book)
  try {
    for (let i = 0; i < 100 && state.prompts.length < 2; i++) await pause(1)
    expect(state.prompts.length).toBe(2)
    await cancelLoop(state.deps, state.book, loop)
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
  } finally { release() }
  await running
  expect(loop.status).toBe('cancelled')
  expect(loop.error).not.toContain('cannot close')
  expect(state.events).toEqual(['loop 1 cancelled'])
  expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
})

test('loop cleanup also runs after a report read or final write exception', async () => {
  for (const phase of ['read', 'write']) {
    const state = loopWith(['dev', 'VERDICT: APPROVED'])
    const read = state.deps.files.read
    let reads = 0
    state.deps.files.read = async path => {
      if (++reads === 3 && phase === 'read') throw new Error('read failed')
      return read(path)
    }
    const write = state.deps.files.write
    state.deps.files.write = async (path, text) => {
      if (path.endsWith('loop-1.md') && phase === 'write') throw new Error('write failed')
      await write(path, text)
    }
    const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
    await runLoop(state.deps, loop, state.book)
    expect(loop.status).toBe('failed')
    expect(loop.error).toContain(`${phase} failed`)
    expect(state.events).toEqual(['loop 1 failed'])
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
  }
})

test('a notification failure still closes the loop panes', async () => {
  const state = loopWith(['dev', 'VERDICT: APPROVED'])
  state.deps.notify = () => { state.events.push('notification attempted'); throw new Error('notify failed') }
  const loop: Loop = { id: await state.book.reserveId(), ...loopRequest(), status: 'developing', rounds: [], startedAt: 0 }
  await runLoop(state.deps, loop, state.book)
  expect(loop.status).toBe('approved')
  expect(state.events).toEqual(['notification attempted'])
  expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2', 'close w1:p3'])
})

test('loop sends changes back to dev with the original task and the QA report path', async () => {
  const state = loopWith(['dev', 'fix this\nVERDICT: CHANGES', 'fixed', 'VERDICT: APPROVED'])
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(loop.rounds).toEqual([{ dev: 2, qa: 3, verdict: 'changes' }, { dev: 4, qa: 5, verdict: 'approved' }])
  expect(state.prompts[2]).toContain(fixTask('add X', '/tmp/codex-team/1-qa1.md'))
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
    expect(loop.error).toContain('/tmp/codex-team/1-qa1.md')
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
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(failureAt === 0 ? ['close w1:p2'] : ['close w1:p2', 'close w1:p3'])
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
  expect(state.events).toEqual(['blocked ct-1-dev', 'blocked ct-1-qa', 'loop 1 approved'])
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
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
    release()
    await state.finished(loop)
    expect(loop.status).toBe('cancelled')
    expect(state.calls).toContain(`keys ct-1-${phase === 0 ? 'dev' : 'qa'} esc`)
    expect(state.prompts.length).toBe(phase + 1)
    expect(state.events).toEqual(['loop 1 cancelled'])
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(phase === 0 ? ['close w1:p2'] : ['close w1:p2', 'close w1:p3'])
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

test('a failed Esc can be retried without releasing the dev slot before its prompt settles', async () => {
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
    expect(await state.book.cancel(dev)).toContain('Sent Esc')
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
        let releaseStop = () => {}
        let starting = false
        let stopping = false
        const gate = new Promise<void>(done => (release = done))
        const stopGate = new Promise<void>(done => (releaseStop = done))
        const state = loopWith(['dev', 'VERDICT: APPROVED'])
        const wait = state.deps.herdr.wait
        state.deps.herdr.wait = async (...args) => { stopping = true; await stopGate; return wait(...args) }
        const start = state.deps.herdr.start
        state.deps.herdr.start = async (...args) => {
          if (args[0] !== `ct-1-${phase === 0 ? 'dev' : 'qa'}`) return start(...args)
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
        if (notReady) {
          for (let i = 0; i < 100 && !stopping; i++) await pause(1)
          expect(stopping).toBe(true)
          expect(other.status).toBe('queued')
          expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
        }
        releaseStop()
        await state.book.ended(child)
        await state.finished(loop)
        expect((await state.book.done(other.id)).status).toBe('done')
        expect(loop.status).toBe('cancelled')
        expect(state.calls.filter(call => call.startsWith(`wait ct-1-${phase === 0 ? 'dev' : 'qa'}`))).toEqual(notReady ? [`wait ct-1-${phase === 0 ? 'dev' : 'qa'} until idle|done`] : [])
        expect(state.calls.some(call => call.startsWith(`prompt ct-1-${phase === 0 ? 'dev' : 'qa'}`))).toBe(false)
        expect(state.prompts.length).toBe(phase + 1)
        expect(state.prompts[phase]).toContain('unrelated')
      }
    }
  }
})

test('loop children cannot reuse a previous report when the new job writes none', async () => {
  const state = loopWith([undefined, undefined])
  state.files['/tmp/codex-team/1-dev1.md'] = 'old dev report'
  state.files['/tmp/codex-team/1-qa1.md'] = 'old QA report\nVERDICT: APPROVED'
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('failed')
  expect(loop.error).toContain('dev 1')
  expect(loop.error).toContain('no report')
  expect(loop.error).toContain('QA report has no VERDICT line: /tmp/codex-team/1-qa1.md')
  expect(state.book.get(3)?.report).toBe(undefined)
})

test('loop fails before starting a child if its old report cannot be invalidated', async () => {
  const state = loopWith(['dev', 'VERDICT: APPROVED'])
  const write = state.deps.files.write
  state.deps.files.write = async (path, text) => {
    if (path === '/tmp/codex-team/1-dev1.md') throw new Error('cannot prepare report')
    await write(path, text)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('failed')
  expect(loop.error).toContain('dev 1')
  expect(loop.error).toContain('cannot prepare report')
  expect(state.calls.some(call => call.startsWith('start '))).toBe(false)
  expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
})

// --- The Herdr adapter over the CLI ---

import { herdrAvailable, herdrOf } from '../hooks/herdr'
import type { Run } from '../hooks/model'

type Answer = { exitCode?: number; stdout?: string; stderr?: string }

// A fake `run` that records argv and answers by the herdr subcommand ("pane split", "agent wait", …).
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
  expect(await herdr.split('down')).toBe('w1:p2')
  expect(argvs[0]).toEqual(['herdr', 'pane', 'split', 'w1:p1', '--direction', 'down', '--cwd', '/proj', '--no-focus'])
  expect(await herdr.split('right', 'w1:p3')).toBe('w1:p2')
  expect(argvs[1]).toEqual(['herdr', 'pane', 'split', 'w1:p3', '--direction', 'right', '--cwd', '/proj', '--no-focus'])
})

test('herdrOf closes the given pane by id', async () => {
  const { herdr, argvs } = adapter({})
  await herdr.close('w1:p2')
  expect(argvs[0]).toEqual(['herdr', 'pane', 'close', 'w1:p2'])
})

test('herdrOf ignores a pane that is already gone but propagates other close errors', async () => {
  for (const code of ['pane_not_found', 'unknown']) {
    const { herdr } = adapter({ 'pane close': { exitCode: 1, stderr: JSON.stringify({ error: { code, message: 'close failed' } }) } })
    const error = await herdr.close('w1:p2').catch(e => e)
    if (code === 'pane_not_found') expect(error).toBeUndefined()
    else {
      expect(error).toBeInstanceOf(HerdrError)
      expect(error.code).toBe('unknown')
    }
  }
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
  await herdr.sendKeys('ct-1', ['esc'])
  expect(argvs[1]).toEqual(['herdr', 'agent', 'send-keys', 'ct-1', 'esc'])
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

function loopHost(on: On, gate?: Promise<void>, script: Script = {}) {
  const promptStates = [...(script.prompt ?? [])]
  const waitStates = [...(script.wait ?? [])]
  const clock = mock.clock(on)
  mock.env(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', TMPDIR: '/tmp' })
  const tools: Record<string, unknown> = {}
  const files: Record<string, string> = {}
  const messages: string[] = []
  const argvs: string[][] = []
  let rows: BandJob[] = []
  let version = 0
  let prompts = 0
  let panes = 1
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
    if (argv[1] === 'pane' && argv[2] === 'split') stdout = JSON.stringify({ result: { pane: { pane_id: `w1:p${++panes}` } } })
    if (argv[1] === 'agent' && argv[2] === 'list') stdout = JSON.stringify({ result: { agents: [] } })
    if (argv[1] === 'agent' && argv[2] === 'prompt') {
      const index = prompts++
      files[argv[4]!.match(/write your final report as Markdown to (.+) and answer/)![1]!] = index === 0 ? 'dev report' : 'VERDICT: APPROVED'
      if (index === 1) await gate
      stdout = agent(String(promptStates.shift() ?? 'done'))
    }
    if (argv[1] === 'agent' && argv[2] === 'wait') stdout = agent(String(waitStates.shift() ?? 'idle'))
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  return { tools, files, messages, argvs, clock, rows: () => rows, prompts: () => prompts }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

test('the host shares the layout across execute, review and loop tools and resets it after loop closes', async ($, on) => {
  const host = loopHost(on)
  await startSession($)
  for (const [index, kind] of ['execute', 'review', 'loop', 'review'].entries()) {
    await $.tool.call({ tool: `mcp__codex-team__${kind}` as 'mcp__codex-team__execute', task: 'add X' })
    for (let i = 0; i < 100 && host.messages.length < index + 1; i++) await pause(1)
    expect(host.messages.length).toBe(index + 1)
    if (kind === 'loop') {
      for (let i = 0; i < 100 && host.argvs.filter(argv => argv[2] === 'close').length < 2; i++) await pause(1)
      expect(host.argvs.filter(argv => argv[2] === 'close')).toEqual([
        ['herdr', 'pane', 'close', 'w1:p4'],
        ['herdr', 'pane', 'close', 'w1:p5'],
      ])
    }
  }
  expect(host.argvs.filter(argv => argv[2] === 'split')).toEqual([
    ['herdr', 'pane', 'split', 'w1:p1', '--direction', 'down', '--cwd', '/proj', '--no-focus'],
    ['herdr', 'pane', 'split', 'w1:p2', '--direction', 'right', '--cwd', '/proj', '--no-focus'],
    ['herdr', 'pane', 'split', 'w1:p3', '--direction', 'right', '--cwd', '/proj', '--no-focus'],
    ['herdr', 'pane', 'split', 'w1:p4', '--direction', 'right', '--cwd', '/proj', '--no-focus'],
    ['herdr', 'pane', 'split', 'w1:p1', '--direction', 'down', '--cwd', '/proj', '--no-focus'],
  ])
})

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
  expect((await $.tool.call({ tool: 'mcp__codex-team__jobs', id: 1 })).result).toContain('QA: ct-1-qa')
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
  expect(host.argvs.some(argv => argv[2] === 'send-keys' && argv[3] === 'ct-1-qa' && argv[4] === 'esc')).toBe(true)
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


test('a rename failure never fails a standalone job', async () => {
  const { deps, calls } = setup({ rename: new Error('rename failed') })
  const j = job()
  await runJob(deps, j, request())
  expect(calls).toContain('rename w1:p2 ct-1 execute')
  expect(j.status).toBe('done')
})

test('herdrOf passes the pane name as one argv element', async () => {
  const { herdr, argvs } = adapter({})
  await herdr.rename('w1:p2', 'loop-1 dev')
  expect(argvs[0]).toEqual(['herdr', 'pane', 'rename', 'w1:p2', 'loop-1 dev'])
})


test('nextFreeId reserves a loop id while either role agent is live', () => {
  expect(nextFreeId(1, ['ct-1-dev', 'ct-2-qa', 'ct-3', 'ct-40-dev'])).toBe(4)
  expect(nextFreeId(1, ['ct-10-dev', 'ct-1-other'])).toBe(1)
})

test('loop reuses exactly two named panes and agents and keeps all round reports', async () => {
  const state = loopWith(['dev one', 'first finding\nVERDICT: CHANGES', 'dev two', 'VERDICT: APPROVED'])
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(state.calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split right w1:p2'])
  expect(state.calls.filter(call => call.startsWith('start'))).toEqual([
    'start ct-1-dev w1:p2 -s workspace-write -a on-request',
    'start ct-1-qa w1:p3 -s read-only -a on-request',
  ])
  expect(state.calls.filter(call => call.startsWith('rename'))).toEqual(['rename w1:p2 loop-1 dev', 'rename w1:p3 loop-1 qa'])
  expect(state.calls.filter(call => call.startsWith('prompt'))).toEqual(['prompt ct-1-dev', 'prompt ct-1-qa', 'prompt ct-1-dev', 'prompt ct-1-qa'])
  expect(state.prompts[2]).toContain(fixTask('add X', '/tmp/codex-team/1-qa1.md'))
  expect(state.prompts[3]).toContain(qaFocus('add X'))
  for (const report of ['1-dev1', '1-qa1', '1-dev2', '1-qa2']) {
    expect(state.files[loop.report!]).toContain(`/tmp/codex-team/${report}.md`)
  }
  expect(state.files['/tmp/codex-team/1-dev1.md']).toBe('dev one')
  for (const id of [2, 3, 4, 5]) expect(state.files[loop.report!]).toContain(`job ct-${id}`)
})

test('loop creates QA only after dev finishes and ignores rename failures', async () => {
  let release = () => {}
  const state = loopWith(['dev', 'VERDICT: APPROVED'], { rename: new Error('cannot rename') }, { 0: new Promise<void>(done => (release = done)) })
  const loop = await loopStart(state.deps, state.book, loopRequest())
  try {
    for (let i = 0; i < 100 && !state.prompts.length; i++) await pause(1)
    expect(state.calls.filter(call => call.startsWith('start')).length).toBe(1)
    expect(state.calls.some(call => call.includes('ct-1-qa'))).toBe(false)
  } finally { release() }
  await state.finished(loop)
  expect(loop.status).toBe('approved')
})

test('every reused phase clears its own report before prompting and never accepts stale QA', async () => {
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'fixed', undefined])
  for (const phase of ['dev', 'qa']) for (const round of [1, 2]) state.files[`/tmp/codex-team/1-${phase}${round}.md`] = 'stale\nVERDICT: APPROVED'
  const prompt = state.deps.herdr.prompt
  state.deps.herdr.prompt = async (...args) => {
    const path = args[1].match(/write your final report as Markdown to (.+) and answer/)![1]!
    expect(state.files[path]).toBe('')
    return prompt(...args)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('failed')
  expect(loop.error).toContain('1-qa2.md')
  expect(state.files['/tmp/codex-team/1-qa1.md']).toBe('VERDICT: CHANGES')
})

test('loop agents are owned by the book and their id survives a reload', async () => {
  const state = loopWith(['dev', 'VERDICT: APPROVED'], { live: ['ct-7-dev', 'ct-7-qa'] })
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  state.deps.herdr.list = async () => state.book.jobs().map(j => ({ name: j.agent, pane: j.pane! }))
  expect(await state.book.orphans()).toEqual([])
  const reloaded = createBook({ ...state.deps, notify: () => {} })
  expect(await reloaded.reserveId()).toBe(2)
})

test('a cancelled loop retries failed Esc while the reused phase still holds the slot', async () => {
  let release = () => {}
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'fixed'], {}, { 2: new Promise<void>(done => (release = done)) })
  const sendKeys = state.deps.herdr.sendKeys
  let attempts = 0
  state.deps.herdr.sendKeys = async (...args) => {
    if (++attempts === 1) throw new Error('transport failed')
    await sendKeys(...args)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  try {
    for (let i = 0; i < 100 && state.prompts.length < 3; i++) await pause(1)
    expect(await cancelLoop(state.deps, state.book, loop)).toContain('transport failed')
    expect(await cancelLoop(state.deps, state.book, loop)).toContain('Sent Esc to ct-1-dev')
    const other = await state.book.start(request())
    await pause(5)
    expect(other.status).toBe('queued')
    release()
    await state.finished(loop)
    await state.book.ended(other.id)
    expect(state.calls.filter(call => call.startsWith('start ct-1-dev')).length).toBe(1)
    expect(attempts).toBe(2)
    expect(loop.status).toBe('cancelled')
  } finally { release() }
})


test('blocked standalone execute and review submit a message to the lead once per episode', async ($, on) => {
  const host = loopHost(on, undefined, { prompt: ['blocked', 'blocked'], wait: ['idle', 'idle'] })
  await startSession($)
  for (const kind of ['execute', 'review']) {
    await $.tool.call({ tool: `mcp__codex-team__${kind}` as 'mcp__codex-team__execute', task: 'add X' })
    for (let i = 0; i < 100 && host.messages.length < (kind === 'execute' ? 2 : 4); i++) await pause(1)
  }
  const blocked = host.messages.filter(message => message.includes('blocked'))
  expect(blocked.length).toBe(2)
  for (const [index, text] of blocked.entries()) {
    expect(text).toContain(`ct-${index + 1}`)
    expect(text).toContain(`pane w1:p${index + 2}`)
    expect(text).toContain('The person must answer in the pane')
    expect(text).toContain('The lead must NOT answer for them')
  }
})

test('blocked loop phases tell the lead the parent and pane once per blocked episode', async ($, on) => {
  const host = loopHost(on, undefined, { prompt: ['blocked', 'blocked'], wait: ['working', 'blocked', 'idle', 'idle'] })
  await startSession($)
  await $.tool.call({ tool: 'mcp__codex-team__loop', task: 'add X' })
  for (let i = 0; i < 100 && !host.messages.some(text => text.includes('loop-1 approved')); i++) await pause(1)
  const blocked = host.messages.filter(message => message.includes('blocked'))
  expect(blocked.length).toBe(3)
  expect(blocked[0]).toContain('ct-1-dev')
  expect(blocked[2]).toContain('ct-1-qa')
  for (const [index, text] of blocked.entries()) {
    expect(text).toContain('loop-1')
    expect(text).toContain(index === 2 ? 'pane w1:p3' : 'pane w1:p2')
    expect(text).toContain('The person must answer in the pane')
    expect(text).toContain('The lead must NOT answer for them')
  }
  expect(host.messages.filter(message => !message.includes('blocked')).length).toBe(1)
})

test('cancelling while a reused phase clears its report sends no new prompt', async () => {
  let release = () => {}
  let clearing = false
  const gate = new Promise<void>(done => (release = done))
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'fixed'])
  const write = state.deps.files.write
  state.deps.files.write = async (path, text) => {
    if (path.endsWith('1-dev2.md')) { clearing = true; await gate }
    await write(path, text)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  try {
    for (let i = 0; i < 100 && !clearing; i++) await pause(1)
    expect(clearing).toBe(true)
    await cancelLoop(state.deps, state.book, loop)
  } finally { release() }
  await state.finished(loop)
  expect(loop.status).toBe('cancelled')
  expect(state.prompts.length).toBe(2)
  expect(state.calls.filter(call => call.startsWith('start')).length).toBe(2)
})

test('each reused phase gets a new 30 minute deadline with chunked waits', async () => {
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'fixed', 'VERDICT: APPROVED'], {
    prompt: Array.from({ length: 4 }, () => new HerdrError('timeout', 'chunk')),
    wait: ['idle', 'idle', 'idle', 'idle'],
  })
  let now = 0
  state.deps.now = () => now
  const prompt = state.deps.herdr.prompt
  const limits: number[] = []
  state.deps.herdr.prompt = async (...args) => {
    limits.push(args[2])
    now += 20 * 60_000
    return prompt(...args)
  }
  const loop = await loopStart(state.deps, createBook({ ...state.deps, notify: () => {} }), loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('approved')
  expect(limits).toEqual([540_000, 540_000, 540_000, 540_000])
  expect(state.calls.filter(call => call.startsWith('wait')).length).toBe(4)
})

test('a cancelled phase holds the execute slot after its deadline until the agent settles', async () => {
  let releasePrompt = () => {}
  let releaseStop = () => {}
  const promptGate = new Promise<void>(done => (releasePrompt = done))
  const stopGate = new Promise<void>(done => (releaseStop = done))
  const state = loopWith(['dev', 'other'], { prompt: ['blocked'] }, { 0: promptGate })
  let now = 0
  let waitingForStop = false
  state.deps.now = () => now
  state.deps.herdr.wait = async () => { waitingForStop = true; await stopGate; return 'idle' }
  const book = createBook({ ...state.deps, notify: () => {} })
  const loop = await loopStart(state.deps, book, loopRequest())
  try {
    for (let i = 0; i < 100 && !state.prompts.length; i++) await pause(1)
    await cancelLoop(state.deps, book, loop)
    now = 30 * 60_000
    releasePrompt()
    const other = await book.start(request())
    await pause(5)
    expect(other.status).toBe('queued')
    expect(waitingForStop).toBe(true)
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
    releaseStop()
    await state.finished(loop)
    expect((await book.done(other.id)).status).toBe('done')
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2'])
  } finally { releasePrompt(); releaseStop() }
})


test('a report clear failure in a later round never prompts or restarts its reused agent', async () => {
  const state = loopWith(['dev', 'VERDICT: CHANGES', 'fixed'])
  const write = state.deps.files.write
  state.deps.files.write = async (path, text) => {
    if (path.endsWith('1-dev2.md')) throw new Error('cannot clear round two')
    await write(path, text)
  }
  const loop = await loopStart(state.deps, state.book, loopRequest())
  await state.finished(loop)
  expect(loop.status).toBe('failed')
  expect(loop.error).toContain('dev 2')
  expect(state.prompts.length).toBe(2)
  expect(state.calls.filter(call => call.startsWith('start')).length).toBe(2)
})

test('a cancelled loop keeps waiting through stop timeouts and permits Esc retries', async () => {
  let releasePrompt = () => {}
  let releaseStop = () => {}
  const state = loopWith(['dev', 'other'], { prompt: ['blocked'] }, { 0: new Promise<void>(done => (releasePrompt = done)) })
  const stopGate = new Promise<void>(done => (releaseStop = done))
  let now = 0
  let waits = 0
  state.deps.now = () => now
  state.deps.herdr.wait = async () => {
    if (++waits === 1) throw new HerdrError('timeout', 'not stopped yet')
    await stopGate
    return 'done'
  }
  const book = createBook({ ...state.deps, notify: () => {} })
  const loop = await loopStart(state.deps, book, loopRequest())
  try {
    for (let i = 0; i < 100 && !state.prompts.length; i++) await pause(1)
    await cancelLoop(state.deps, book, loop)
    now = 30 * 60_000
    releasePrompt()
    const other = await book.start(request())
    for (let i = 0; i < 100 && waits < 2; i++) await pause(1)
    expect(waits).toBe(2)
    expect(other.status).toBe('queued')
    expect(await cancelLoop(state.deps, book, loop)).toContain('Sent Esc')
    expect(state.calls.some(call => call.startsWith('close'))).toBe(false)
    releaseStop()
    await state.finished(loop)
    await book.ended(other.id)
    expect(state.calls.filter(call => call.startsWith('close'))).toEqual(['close w1:p2'])
  } finally { releasePrompt(); releaseStop() }
})
