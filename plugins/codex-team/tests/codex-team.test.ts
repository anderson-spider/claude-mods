import { expect, test } from 'claude-code/testing'

import { agentName, buildPrompt, codexArgs, nextFreeId, reportPath, requestOf, splitDirection } from '../hooks/team'

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

// --- Job lifecycle, against a scripted Herdr ---

import { HerdrError, runJob } from '../hooks/team'
import type { AgentState, Deps, Herdr, Job, Request, Settled } from '../hooks/team'

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
    files: { read: async path => files[path] },
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

import { createBook, jobDetail, jobsReport } from '../hooks/team'

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
    files: { read: async () => 'report text' },
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

// --- The Herdr adapter over the CLI ---

import { herdrAvailable, herdrOf } from '../hooks/herdr'
import type { Run } from '../hooks/herdr'

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
