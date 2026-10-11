// The Codex engine over a fake host: what the register tests cannot raise (a card write or a notice that fails after
// its hook, a host that goes away under a running job, a worker that does not start, a kill that fails), and the
// shared poller.
import { expect, test } from 'claude-code/testing'
import type { AgentCard } from '../types'
import { createCodexEngine } from '../hooks/codex/engine'
import type { CodexHost } from '../hooks/codex/engine'
import { PID, fakeProcesses, pause } from './codex-fake'
import type { Run, Scenario } from './codex-fake'
import { CODEX_EXEC_0_162_SUCCESS } from './fixtures/codex-exec-0.162'
import { createGate, createJev } from '../hooks/jev'
import type { JevIo } from '../hooks/jev'
import { QUESTIONS } from '../hooks/questions'

const ROOT = '/repo'
const DIR = `${ROOT}/.crew/codex`
const RUNNING: Scenario = { jsonl: '{"type":"thread.started","thread_id":"00000000-0000-4000-8000-0000000000aa"}\n{"type":"turn.started"}\n' }

type Fake = {
  host: CodexHost
  files: Map<string, string>
  runs: Run[]
  alive: Set<number>
  logs: string[]
  notes: string[]
  submitted: string[]
  jobWrites: () => number
  cards: () => AgentCard[]
  /** Lets the polls that wait for time go on once. */
  tick: () => void
}

function fakeHost(opts: {
  files?: Map<string, string>
  scenario?: () => Scenario
  cardsFail?: () => boolean
  noteFails?: () => boolean
  submitFails?: () => boolean
  dead?: () => boolean
  workerFails?: boolean
  /** The repository top-level for a directory (the session's by default). */
  gitTop?: (cwd: string) => string | null
  killFails?: boolean
  psCommand?: (pid: number) => string
  /** A file write takes a few milliseconds, as a real one can. */
  slowWrites?: boolean
} = {}): Fake {
  const files = opts.files ?? new Map<string, string>()
  const runs: Run[] = []
  const alive = new Set<number>()
  const logs: string[] = []
  const notes: string[] = []
  const submitted: string[] = []
  let jobWrites = 0
  let cards: AgentCard[] = []
  let waiting: (() => void)[] = []
  const tick = () => { const now = waiting; waiting = []; for (const go of now) go() }
  const run = fakeProcesses({
    files, dirs: new Set([ROOT]), runs, alive, gitTop: opts.gitTop ?? (() => ROOT),
    gate: () => new Promise<void>(resolve => { waiting.push(resolve) }),
    scenario: opts.scenario ?? (() => ({ jsonl: CODEX_EXEC_0_162_SUCCESS.jsonl, exit: 0 })), workerFails: opts.workerFails,
    psCommand: opts.psCommand,
  })
  const check = () => { if (opts.dead?.()) throw new Error('host gone') }
  const host: CodexHost = {
    run: async (argv, init) => {
      check()
      if (opts.killFails && argv[0] === 'kill') return { exitCode: 1, stdout: '', stderr: 'kill: operation not permitted' }
      return run(argv, init)
    },
    read: async path => { check(); const text = files.get(path); if (text === undefined) throw new Error('ENOENT'); return text },
    write: async (path, text) => { check(); if (opts.slowWrites) await pause(5); files.set(path, text) },
    list: async dir => [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1)),
    realPath: async path => path,
    cwd: async () => ROOT,
    sessionId: async () => 'session-1',
    sleep: async () => { check(); await Promise.resolve() },
    log: text => { logs.push(text) },
    note: text => { if (opts.noteFails?.()) throw new Error('log refused'); notes.push(text) },
    submit: async text => { check(); if (opts.submitFails?.()) throw new Error('submit refused'); submitted.push(text) },
    writeCards: async change => { check(); if (opts.cardsFail?.()) throw new Error('state refused'); cards = change(cards) },
    writeJobs: async () => { check(); jobWrites++ },
  }
  return { host, files, runs, alive, logs, notes, submitted, jobWrites: () => jobWrites, cards: () => cards, tick }
}

/** Distinct job ids: the clock stands still, so the random part tells jobs apart. */
const counter = () => { let n = 0; return () => (n = (n + 0.1234567) % 1) }
const engineOf = () => createCodexEngine({ prompts: { developer: 'dev prompt' }, models: {}, now: () => 5000, random: counter() })
const parsed = (text: string) => JSON.parse(text) as Record<string, unknown>

async function settle(rounds = 50) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/** Reads the job until its status is one of `statuses`, moving the poller one tick each time. */
async function until(engine: ReturnType<typeof engineOf>, fake: Pick<Fake, 'tick'>, jobId: unknown, statuses: string[], tries = 200) {
  let last: Record<string, unknown> = {}
  for (let i = 0; i < tries; i++) {
    last = parsed((await engine.result(jobId)).text)
    if (statuses.includes(String(last.status))) return last
    fake.tick()
    await settle(20)
  }
  throw new Error(`job stayed ${String(last.status)}`)
}

test('a card write that fails is kept, logged once, and written by the next flush', async () => {
  let failing = true
  const fake = fakeHost({ cardsFail: () => failing })
  const engine = engineOf()
  engine.useHost(fake.host)

  const answer = await engine.start({ agent: 'code-reader', prompt: 'list', description: 'list' }, fake.host)
  const jobId = String(parsed(answer.text).jobId)
  expect(parsed(answer.text).status).toBe('done')
  await engine.flush()
  expect(fake.cards()).toEqual([])
  expect(fake.logs.filter(line => line.includes('panel write failed')).length).toBe(1)

  failing = false
  await engine.flush()
  expect(fake.cards().map(card => [card.id, card.type, card.status])).toEqual([[jobId, 'codex:code-reader', 'done']])
})

test('an end notice that fails once is retried by the next flush and never lost', async () => {
  let noteFails = true
  let submitFails = true
  const fake = fakeHost({ scenario: () => RUNNING, noteFails: () => noteFails, submitFails: () => submitFails })
  const engine = engineOf()
  engine.useHost(fake.host)

  const jobId = String(parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'd', background: true }, fake.host)).text).jobId)
  await until(engine, fake, jobId, ['background'])
  fake.files.set(`${DIR}/${jobId}.jsonl`, CODEX_EXEC_0_162_SUCCESS.jsonl)
  fake.files.set(`${DIR}/${jobId}.exit`, '0\n')
  await until(engine, fake, jobId, ['done'])
  await engine.flush()
  await settle()
  expect(fake.notes).toEqual([])
  expect(fake.submitted).toEqual([])

  noteFails = false
  await engine.flush()
  await settle()
  const notice = `Codex job ${jobId} (developer) ended with done; use codex_result({ jobId: '${jobId}' }).`
  expect(fake.notes).toEqual([notice])
  expect(fake.submitted).toEqual([])

  submitFails = false
  await engine.flush()
  await settle()
  await engine.flush()
  await settle()
  // Delivered once each: the transcript line is not repeated by the retry of the prompt.
  expect(fake.notes).toEqual([notice])
  expect(fake.submitted).toEqual([notice])
})

test('one poll process reads every running job, with one ps for all their pids', async () => {
  const fake = fakeHost({ scenario: () => RUNNING })
  fake.alive.add(PID)
  const engine = engineOf()
  engine.useHost(fake.host)

  const a = parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'a', background: true }, fake.host)).text).jobId
  const b = parsed((await engine.start({ agent: 'tester', prompt: 'p', description: 'b', background: true }, fake.host)).text).jobId
  await until(engine, fake, a, ['background'])
  for (let i = 0; i < 10; i++) { fake.tick(); await settle(20) }

  const polls = fake.runs.filter(run => run.argv[3] === 'crew-codex-poll')
  const both = polls.filter(run => run.argv.includes(String(a)) && run.argv.includes(String(b)))
  expect(both.length).toBeGreaterThan(0)
  // The pids ride in one argument; no ps, sleep or tail of its own per job.
  expect(both.at(-1)!.argv[7]).toBe(`${PID},${PID}`)
  expect(fake.runs.some(run => ['ps', 'tail', 'sleep'].includes(run.argv[0]!))).toBe(false)
  // The JSONL is read from an offset: once its lines were handed on, later polls ask from past them.
  const offsets = both.map(run => Number(run.argv[run.argv.indexOf(String(a)) + 2]))
  expect(offsets.at(-1)).toBe(RUNNING.jsonl.length)
})

test('a card update the throttle held is written by a later poll, so the card ends on the latest activity', async () => {
  const fake = fakeHost({ scenario: () => RUNNING })
  fake.alive.add(PID)
  let now = 5000
  const engine = createCodexEngine({ prompts: {}, models: {}, now: () => now, random: counter() })
  engine.useHost(fake.host)
  const jobId = String(parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'd', background: true }, fake.host)).text).jobId)
  await until(engine, fake, jobId, ['background'])
  for (let i = 0; i < 5; i++) { fake.tick(); await settle(20) }
  const card = () => fake.cards().find(c => c.id === jobId)
  expect(card()?.status).toBe('running')

  // Within the same second as the last write: the throttle holds the card back.
  const command = '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls","exit_code":0,"status":"completed"}}\n'
  fake.files.set(`${DIR}/${jobId}.jsonl`, RUNNING.jsonl + command)
  for (let i = 0; i < 5; i++) { fake.tick(); await settle(20) }
  await engine.flush()
  expect(card()?.tools.map(t => t.text)).not.toContain('$ ls → 0')

  // Nothing new arrives; once the second has passed, the next poll writes the held card.
  now += 1500
  for (let i = 0; i < 5; i++) { fake.tick(); await settle(20) }
  await engine.flush()
  expect(card()?.tools.map(t => t.text)).toContain('$ ls → 0')
})

test('a job whose poll host goes away goes on with the newest host', async () => {
  let gone = false
  const files = new Map<string, string>()
  const first = fakeHost({ files, dead: () => gone, scenario: () => RUNNING })
  const engine = engineOf()
  engine.useHost(first.host)
  const started = parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'd', background: true }, first.host)).text)
  await until(engine, first, started.jobId, ['background'])

  gone = true
  // The poll in flight ends; the next ones fail on the gone host, and the poller waits for a new one.
  first.tick()
  await settle(200)
  // Codex ends while no host can read it.
  files.set(`${DIR}/${String(started.jobId)}.jsonl`, CODEX_EXEC_0_162_SUCCESS.jsonl)
  files.set(`${DIR}/${String(started.jobId)}.exit`, '0\n')
  const second = fakeHost({ files })
  engine.useHost(second.host)
  expect((await until(engine, second, started.jobId, ['done', 'error', 'lost'])).status).toBe('done')
  expect(first.logs.some(line => line.includes('poll failed'))).toBe(true)
})

test('a worker that does not start ends the job as an error with the reason', async () => {
  const fake = fakeHost({ workerFails: true })
  const engine = engineOf()
  engine.useHost(fake.host)

  const answer = await engine.start({ agent: 'developer', prompt: 'p', description: 'd' }, fake.host)

  expect(answer.isError).toBe(true)
  expect(String(parsed(answer.text).error)).toContain('the Codex worker did not start')
})

test('a kill that fails is surfaced by codex_cancel and kept on the job, which stays running', async () => {
  const fake = fakeHost({ scenario: () => RUNNING, killFails: true })
  fake.alive.add(PID)
  const engine = engineOf()
  engine.useHost(fake.host)
  const jobId = parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'd', background: true }, fake.host)).text).jobId
  // The worker has started once the poller reads its files.
  for (let i = 0; i < 20 && !fake.runs.some(run => run.argv[3] === 'crew-codex-poll'); i++) await settle(20)

  const answer = await engine.cancel(jobId)
  expect(answer.isError).toBe(true)
  expect(answer.text).toContain('kill -INT 4242 failed')
  const after = parsed((await engine.result(jobId)).text)
  expect(after).toEqual(expect.objectContaining({ status: 'background', cancelling: true }))
  expect(String(after.cancelError)).toContain('operation not permitted')
})

test('a cancel never signals a pid that ps does not name a running codex exec, and the next cancel looks again', async () => {
  let command = 'vim notes.txt'
  const fake = fakeHost({ scenario: () => RUNNING, psCommand: () => command })
  const engine = engineOf()
  engine.useHost(fake.host)
  const jobId = parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'd', background: true }, fake.host)).text).jobId
  for (let i = 0; i < 20 && !fake.runs.some(run => run.argv[3] === 'crew-codex-poll'); i++) await settle(20)

  // The pid the job holds now names another program (its files sit in the job's writable workspace).
  const refused = await engine.cancel(jobId)
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain(`pid ${PID} is not a running codex exec`)
  expect(fake.runs.some(run => run.argv[0] === 'kill')).toBe(false)
  expect(parsed((await engine.result(jobId)).text)).toEqual(expect.objectContaining({ cancelling: true, cancelError: expect.stringContaining('not a running codex exec') }))

  // Once ps names it Codex again, a second cancel sends the SIGINT, once.
  command = 'codex exec --json -s workspace-write -'
  expect(parsed((await engine.cancel(jobId)).text).status).toBe('cancelling')
  expect(fake.runs.filter(run => run.argv[0] === 'kill').map(run => run.argv)).toEqual([['kill', '-INT', String(PID)]])
  expect((await until(engine, fake, jobId, ['cancelled', 'error', 'done', 'lost'])).status).toBe('cancelled')
})

test('Esc during the foreground wait returns the job as background at once and asks Codex to stop', async () => {
  const fake = fakeHost({ scenario: () => RUNNING })
  const engine = engineOf()
  engine.useHost(fake.host)
  const listeners: (() => void)[] = []
  const signal = {
    aborted: false,
    addEventListener: (_type: string, listener: () => void) => { listeners.push(listener) },
    removeEventListener: (_type: string, listener: () => void) => { const at = listeners.indexOf(listener); if (at >= 0) listeners.splice(at, 1) },
  }
  let answered: { text: string } | undefined
  void engine.start({ agent: 'developer', prompt: 'p', description: 'fg' }, fake.host, signal as unknown as AbortSignal).then(answer => { answered = answer })
  // Held: the wait process runs (the fake's never ends while the job runs).
  for (let i = 0; i < 50 && !fake.runs.some(run => run.argv[3] === 'crew-codex-wait'); i++) await settle(20)
  expect(fake.runs.some(run => run.argv[3] === 'crew-codex-wait')).toBe(true)
  expect(answered).toBeUndefined()

  signal.aborted = true
  for (const listener of [...listeners]) listener()
  for (let i = 0; i < 50 && !answered; i++) await settle(20)
  expect(answered).toBeDefined()
  const answer = parsed(answered!.text)
  expect(answer).toEqual(expect.objectContaining({ status: 'background', cancelling: true }))
  expect(String(answer.next)).toContain('codex_result')
  for (let i = 0; i < 50 && !fake.runs.some(run => run.argv[0] === 'kill'); i++) { fake.tick(); await settle(20) }
  expect(fake.runs.filter(run => run.argv[0] === 'kill').length).toBe(1)
})

test('background true returns only once the job record is on disk, even when the write is slow', async () => {
  const fake = fakeHost({ scenario: () => RUNNING, slowWrites: true })
  const engine = engineOf()
  engine.useHost(fake.host)
  const jobId = String(parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'bg', background: true }, fake.host)).text).jobId)
  expect(JSON.parse(fake.files.get(`${DIR}/${jobId}.json`) ?? '{}')).toEqual(expect.objectContaining({ id: jobId, owner: 'session-1' }))
})

test('a call whose signal was already aborted starts nothing', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const signal = { aborted: true, addEventListener: () => {}, removeEventListener: () => {} } as unknown as AbortSignal
  const answer = await engine.start({ agent: 'developer', prompt: 'p', description: 'd' }, fake.host, signal)
  expect(parsed(answer.text)).toEqual(expect.objectContaining({ status: 'cancelled' }))
  expect(fake.runs.some(run => run.argv[3] === 'crew-codex')).toBe(false)
})

test('Esc while the call is still preparing the job returns cancelled, leaves no job active and no record', async () => {
  const fake = fakeHost({ scenario: () => RUNNING })
  const engine = engineOf()
  engine.useHost(fake.host)
  const listeners: (() => void)[] = []
  const signal = {
    aborted: false,
    addEventListener: (_type: string, listener: () => void) => { listeners.push(listener) },
    removeEventListener: () => {},
  }
  let answered: { text: string } | undefined
  void engine.start({ agent: 'developer', prompt: 'p', description: 'mid' }, fake.host, signal as unknown as AbortSignal).then(answer => { answered = answer })
  // Aborted during start's first awaits (load, the paths, git, mkdir), before the job exists.
  await Promise.resolve()
  signal.aborted = true
  for (const listener of [...listeners]) listener()
  for (let i = 0; i < 50 && !answered; i++) await settle(20)

  expect(answered).toBeDefined()
  expect(parsed(answered!.text)).toEqual(expect.objectContaining({ status: 'cancelled' }))
  expect(fake.runs.some(run => run.argv[3] === 'crew-codex')).toBe(false)
  const records = [...fake.files.keys()].filter(path => /\/cx-[^/]+\.json$/.test(path))
  expect(records).toEqual([])
  await engine.flush()
  expect(fake.cards()).toEqual([])
})

test('a cancel asked while the worker is still starting sends SIGINT once the worker exists', async () => {
  const fake = fakeHost({ scenario: () => RUNNING })
  fake.alive.add(PID)
  const engine = engineOf()
  engine.useHost(fake.host)
  const jobId = parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'd', background: true }, fake.host)).text).jobId

  expect(parsed((await engine.cancel(jobId)).text).status).toBe('cancelling')
  expect((await until(engine, fake, jobId, ['cancelled', 'error', 'done', 'lost'])).status).toBe('cancelled')
  expect(fake.runs.filter(run => run.argv[0] === 'kill').map(run => run.argv)).toEqual([['kill', '-INT', String(PID)]])
})

test('the job list atom is written when a status or session moves, not on every event', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)

  await engine.start({ agent: 'code-reader', prompt: 'p', description: 'd' }, fake.host)
  await engine.flush()
  // running, session known, done: the seven JSONL events add nothing.
  expect(fake.jobWrites()).toBeLessThanOrEqual(3)
  expect(fake.jobWrites()).toBeGreaterThan(0)
})

test('two resumes of one job at once: the second is refused', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const first = parsed((await engine.start({ agent: 'code-reader', prompt: 'p', description: 'd' }, fake.host)).text)
  expect(first.status).toBe('done')

  const [a, b] = await Promise.all([
    engine.start({ agent: 'code-reader', prompt: 'p', description: 'd', resume: first.jobId, background: true }, fake.host),
    engine.start({ agent: 'code-reader', prompt: 'p', description: 'd', resume: first.jobId, background: true }, fake.host),
  ])
  const answers = [a, b].map(answer => answer.text)
  expect(answers.filter(text => text.includes('already'))).toHaveLength(1)
  expect(fake.runs.filter(run => run.argv[3] === 'crew-codex' && run.argv.includes('resume'))).toHaveLength(1)
})

test('bad input is refused before anything runs', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)

  expect((await engine.start({ agent: 'planner', prompt: 'p', description: 'd' }, fake.host)).text).toContain('Unknown agent')
  expect((await engine.start({ agent: 'developer', prompt: '  ', description: 'd' }, fake.host)).text).toContain('prompt is required')
  expect((await engine.result(42)).isError).toBe(true)
  expect((await engine.cancel('cx-0-zzzzz')).text).toContain('Unknown job')
  expect([...fake.files.keys()]).toEqual([])
})

// --- effort ---

const argvOf = (fake: Fake, nth = -1) => fake.runs.filter(run => run.argv[3] === 'crew-codex').at(nth)!.argv.join(' ')
const recordOfJob = (fake: Fake, id: unknown) => JSON.parse(fake.files.get(`${DIR}/${String(id)}.json`) ?? '{}') as Record<string, unknown>

test('the sizer decides the effort: it reaches argv, the record, the card tag and codex_result', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const seen: unknown[][] = []
  const size = async (...args: unknown[]) => { seen.push(args.slice(0, 3)); return 'high' as const }
  const answer = parsed((await engine.start({ agent: 'developer', prompt: 'big task', description: 'refactor' }, fake.host, undefined, size)).text)
  expect(seen).toEqual([['developer', 'refactor', 'big task']])
  expect(answer.effort).toBe('high')
  expect(argvOf(fake)).toContain('model_reasoning_effort="high"')
  expect(recordOfJob(fake, answer.jobId).effort).toBe('high')
  await engine.flush()
  expect(fake.cards().at(-1)?.description).toBe('refactor · codex/high')
  expect(parsed((await engine.result(answer.jobId)).text).effort).toBe('high')
})

test('no sizer: no effort flag and no effort on the record', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const answer = parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'd' }, fake.host)).text)
  expect(argvOf(fake)).not.toContain('model_reasoning_effort')
  expect(recordOfJob(fake, answer.jobId)).not.toHaveProperty('effort')
  expect(answer).not.toHaveProperty('effort')
})

test('a sizer that rejects leaves the job without an effort instead of failing it', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const answer = parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'd' }, fake.host, undefined, () => Promise.reject(new Error('boom')))).text)
  expect(answer.status).toBe('done')
  expect(argvOf(fake)).not.toContain('model_reasoning_effort')
})

test('a refused call never reaches the sizer', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  let calls = 0
  const size = async () => { calls++; return 'high' as const }
  await engine.start({ agent: 'planner', prompt: 'p', description: 'd' }, fake.host, undefined, size)
  await engine.start({ agent: 'developer', prompt: ' ', description: 'd' }, fake.host, undefined, size)
  await engine.start({ agent: 'developer', prompt: 'p', description: 'd', resume: 'cx-nope-00000' }, fake.host, undefined, size)
  await engine.start({ agent: 'developer', prompt: 'p', description: 'd', cwd: '/nowhere' }, { ...fake.host, realPath: async path => (path === '/nowhere' ? undefined : path) }, undefined, size)
  expect(calls).toBe(0)
})

test('Esc while the sizer is pending answers at once, runs no worker and writes no record; the sizer was not awaited', async () => {
  const fake = fakeHost({ scenario: () => RUNNING })
  const engine = engineOf()
  engine.useHost(fake.host)
  const listeners: (() => void)[] = []
  const signal = { aborted: false, addEventListener: (_t: string, l: () => void) => { listeners.push(l) }, removeEventListener: () => {} }
  let answered: { text: string } | undefined
  let started = false
  const size = () => { started = true; return new Promise<'high'>(() => {}) }
  void engine.start({ agent: 'developer', prompt: 'p', description: 'esc' }, fake.host, signal as unknown as AbortSignal, size).then(a => { answered = a })
  for (let i = 0; i < 50 && !started; i++) await settle(5)
  expect(started).toBe(true)
  await settle(100)
  expect(answered).toBeUndefined()
  signal.aborted = true
  for (const listener of [...listeners]) listener()
  for (let i = 0; i < 50 && !answered; i++) await settle(20)
  expect(parsed(answered!.text)).toEqual(expect.objectContaining({ status: 'cancelled' }))
  expect(fake.runs.some(run => run.argv[3] === 'crew-codex')).toBe(false)
  expect([...fake.files.keys()].filter(path => /\/cx-[^/]+\.json$/.test(path))).toEqual([])
})

test('startedAt is taken after the sizer returns', async () => {
  const fake = fakeHost()
  let clock = 1000
  const engine = createCodexEngine({ prompts: { developer: 'dev prompt' }, models: {}, now: () => clock, random: counter() })
  engine.useHost(fake.host)
  const size = async () => { clock = 4000; return 'medium' as const }
  const answer = parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'd', background: true }, fake.host, undefined, size)).text)
  expect(recordOfJob(fake, answer.jobId).startedAt).toBe(4000)
})

test('resume never calls the sizer and passes the original job\'s effort; an older record resumes with no flag', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const first = parsed((await engine.start({ agent: 'code-reader', prompt: 'p', description: 'd' }, fake.host, undefined, async () => 'high')).text)
  let calls = 0
  const size = async () => { calls++; return 'low' as const }
  const again = parsed((await engine.start({ agent: 'code-reader', prompt: 'more', description: 'd', resume: first.jobId }, fake.host, undefined, size)).text)
  expect(calls).toBe(0)
  expect(argvOf(fake)).toContain('model_reasoning_effort="high"')
  expect(argvOf(fake)).toContain('resume')
  expect(recordOfJob(fake, again.jobId).effort).toBe('high')

  // A record from before efforts were passed.
  const legacy = recordOfJob(fake, first.jobId)
  delete legacy.effort
  const id = 'cx-old-00001'
  const fake2 = fakeHost({ files: new Map([[`${DIR}/${id}.json`, JSON.stringify({ ...legacy, id, owner: 'session-1' })]]) })
  const engine2 = engineOf()
  engine2.useHost(fake2.host)
  await engine2.start({ agent: 'code-reader', prompt: 'more', description: 'd', resume: id }, fake2.host, undefined, size)
  expect(argvOf(fake2)).toContain('resume')
  expect(argvOf(fake2)).not.toContain('model_reasoning_effort')
  expect(calls).toBe(0)
})

test('a job followed again after a reload keeps its effort in the record when it ends', async () => {
  const id = 'cx-rl-00001'
  const files = new Map<string, string>([
    [`${DIR}/${id}.json`, JSON.stringify({ v: 1, id, agent: 'developer', description: 'd', cwd: ROOT, status: 'background', startedAt: 1, pid: PID, owner: 'session-1', effort: 'high' })],
    [`${DIR}/${id}.jsonl`, RUNNING.jsonl ?? ''],
  ])
  const fake = fakeHost({ files })
  fake.alive.add(PID)
  const engine = engineOf()
  engine.useHost(fake.host)
  expect((await until(engine, fake, id, ['background', 'running'], 5)).effort).toBe('high')
  files.set(`${DIR}/${id}.jsonl`, CODEX_EXEC_0_162_SUCCESS.jsonl)
  files.set(`${DIR}/${id}.exit`, '0\n')
  fake.alive.clear()
  expect((await until(engine, fake, id, ['done', 'error', 'lost'])).status).toBe('done')
  expect(recordOfJob(fake, id)).toEqual(expect.objectContaining({ status: 'done', effort: 'high' }))
})

test('a job adopted from another session keeps its effort in the record', async () => {
  const id = 'cx-ad-00001'
  const files = new Map<string, string>([
    [`${DIR}/${id}.json`, JSON.stringify({ v: 1, id, agent: 'developer', description: 'd', cwd: ROOT, status: 'running', startedAt: 1, pid: PID, owner: 'other', effort: 'high' })],
    [`${DIR}/${id}.jsonl`, CODEX_EXEC_0_162_SUCCESS.jsonl],
    [`${DIR}/${id}.exit`, '0\n'],
  ])
  const fake = fakeHost({ files })
  const engine = engineOf()
  engine.useHost(fake.host)
  expect((await until(engine, fake, id, ['done', 'error', 'lost'])).effort).toBe('high')
  expect(recordOfJob(fake, id)).toEqual(expect.objectContaining({ status: 'done', effort: 'high', owner: 'other' }))
})

// --- S: Esc with a gated Jev request still in flight ---

test('S: Esc while a gated Jev fetch hangs answers at once; the slot stays held until the fetch settles, and the late answer starts nothing', async () => {
  const fake = fakeHost({ scenario: () => RUNNING })
  const engine = engineOf()
  engine.useHost(fake.host)
  const settleFetch: (() => void)[] = []
  const body = JSON.stringify({ model: 'jev-1.13.0', answers: { tier: { choice: 'opus', confidence: 0.9 }, reasoning_depth: { score: 3.5, confidence: 0.5 } } })
  const io: JevIo = {
    fetch: () => new Promise(resolve => { settleFetch.push(() => resolve({ status: 200, text: body })) }),
    // Neither the deadline nor the slot's hold ceiling fires: only the fetch settling can free the slot.
    timer: () => () => {},
    now: () => 0,
  }
  const gate = createGate(1)
  const ask = createJev(io, ['key-', 'jev-0123456789abcdef'].join(''), { model: 'jev-1.13.0', gate })
  let late: string | undefined
  const size = async () => {
    try { await ask(QUESTIONS, {}); late = 'high'; return 'high' as const } catch { late = 'medium'; return 'medium' as const }
  }
  const stop = new AbortController()
  let answered: { text: string } | undefined
  void engine.start({ agent: 'developer', prompt: 'p', description: 'esc-gated' }, fake.host, stop.signal, size).then(a => { answered = a })
  for (let i = 0; i < 50 && settleFetch.length === 0; i++) await settle(5)
  expect(settleFetch.length).toBe(1)
  expect(answered).toBeUndefined()

  stop.abort()
  for (let i = 0; i < 50 && !answered; i++) await settle(20)
  expect(parsed(answered!.text)).toEqual(expect.objectContaining({ status: 'cancelled' }))
  expect(late).toBeUndefined()
  // The request cannot be aborted: its slot is still taken.
  expect(gate.acquire()).toBe(false)

  settleFetch[0]!()
  await settle(50)
  expect(late).toBe('high')
  // Settled after the abort: the slot is free again.
  expect(gate.acquire()).toBe(true)
  gate.release()
  // The late answer creates nothing.
  expect(fake.runs.some(run => run.argv[3] === 'crew-codex')).toBe(false)
  expect([...fake.files.keys()].filter(path => /\/cx-[^/]+\.json$/.test(path))).toEqual([])
  expect(await engine.list()).toEqual([])
})

test('S: Esc that lands during the checks before sizing (here the cwd lookup) sends nothing to the sizer', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const stop = new AbortController()
  let calls = 0
  const size = async () => { calls++; return 'high' as const }
  const host: CodexHost = { ...fake.host, realPath: async path => { stop.abort(); return path } }
  const answer = parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'late esc' }, host, stop.signal, size)).text)
  expect(answer.status).toBe('cancelled')
  // "No request leaves for an aborted call": the prompt must not reach Jev once Esc was pressed.
  expect(calls).toBe(0)
  expect(fake.runs.some(run => run.argv[3] === 'crew-codex')).toBe(false)
})

test('S: a resume aborted before sizing starts nothing, never sizes, and frees its reservation for the next resume', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const first = parsed((await engine.start({ agent: 'code-reader', prompt: 'p', description: 'd' }, fake.host, undefined, async () => 'high')).text)
  expect(first.status).toBe('done')
  const workers = () => fake.runs.filter(run => run.argv[3] === 'crew-codex').length
  const before = workers()
  let calls = 0
  const size = async () => { calls++; return 'low' as const }
  const stop = new AbortController()
  // The resume's cwd check is the last await before the sizer; Esc lands there.
  const host: CodexHost = { ...fake.host, realPath: async path => { stop.abort(); return path } }
  const aborted = parsed((await engine.start({ agent: 'code-reader', prompt: 'more', description: 'd', resume: first.jobId, cwd: ROOT }, host, stop.signal, size)).text)
  expect(aborted.status).toBe('cancelled')
  expect(workers()).toBe(before)

  const again = parsed((await engine.start({ agent: 'code-reader', prompt: 'more', description: 'd', resume: first.jobId }, fake.host, undefined, size)).text)
  expect(again.status).toBe('done')
  expect(workers()).toBe(before + 1)
  expect(argvOf(fake)).toContain('model_reasoning_effort="high"')
  expect(calls).toBe(0)
})

test('S: a normal start sizes exactly once', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  let calls = 0
  const stop = new AbortController()
  const answer = parsed((await engine.start({ agent: 'developer', prompt: 'p', description: 'once' }, fake.host, stop.signal, async () => { calls++; return 'high' as const })).text)
  expect(calls).toBe(1)
  expect(answer.effort).toBe('high')
  expect(argvOf(fake)).toContain('model_reasoning_effort="high"')
})

test('S: the sizer gets the job id, and a description that carries a card tag is cleaned before the sizer, the record and the output name', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const seen: unknown[][] = []
  const size = async (...args: unknown[]) => { seen.push(args); return 'medium' as const }
  const answer = parsed((await engine.start({ agent: 'architect', prompt: 'p', description: 'audit auth · codex/medium' }, fake.host, undefined, size)).text)
  expect(seen[0]![1]).toBe('audit auth')
  expect(seen[0]![4]).toBe(answer.jobId)
  expect(answer.description).toBe('audit auth')
  expect(String(answer.output)).toContain('/audit-auth-')
  expect(String(answer.output)).not.toContain('codex')
})

test('S: a read-only job run in another repository writes its -o file and .crew there, not in the session\'s', async () => {
  const other = '/other-repo'
  const fake = fakeHost({ gitTop: cwd => (cwd === other || cwd.startsWith(`${other}/`) ? other : ROOT) })
  const engine = engineOf()
  engine.useHost(fake.host)
  const away = parsed((await engine.start({ agent: 'architect', prompt: 'p', description: 'away', cwd: other }, fake.host)).text)
  expect(String(away.output).startsWith(`${other}/.crew/reviews/`)).toBe(true)
  expect(fake.files.get(`${other}/.crew/.gitignore`)).toBe('*\n')
  const home = parsed((await engine.start({ agent: 'architect', prompt: 'p', description: 'home' }, fake.host)).text)
  expect(String(home.output).startsWith(`${ROOT}/.crew/reviews/`)).toBe(true)
  // The job's own files stay with the session.
  expect(fake.files.has(`${DIR}/${String(away.jobId)}.json`)).toBe(true)
})

test('S: a read-only job outside any repository, or in a nested repository inside the session\'s tree, keeps -o and .crew in the session base', async () => {
  const fake = fakeHost({
    gitTop: cwd => (cwd === '/loose' || cwd.startsWith('/loose/') ? null : cwd.startsWith(`${ROOT}/pkg`) ? `${ROOT}/pkg` : ROOT),
  })
  const engine = engineOf()
  engine.useHost(fake.host)
  const loose = parsed((await engine.start({ agent: 'research', prompt: 'p', description: 'loose', cwd: '/loose' }, fake.host)).text)
  expect(String(loose.output).startsWith(`${ROOT}/.crew/research/`)).toBe(true)
  expect([...fake.files.keys()].some(path => path.startsWith('/loose/'))).toBe(false)
  const sub = parsed((await engine.start({ agent: 'architect', prompt: 'p', description: 'sub', cwd: `${ROOT}/pkg/a` }, fake.host)).text)
  expect(String(sub.output).startsWith(`${ROOT}/.crew/reviews/`)).toBe(true)
  expect([...fake.files.keys()].some(path => path.startsWith(`${ROOT}/pkg/`))).toBe(false)
})

test('S: the record on disk keeps the untagged description; a look-alike that is not a tag is left as typed', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const tagged = parsed((await engine.start({ agent: 'code-reader', prompt: 'p', description: '  find it · gpt-5.3-codex-max/high  ' }, fake.host)).text)
  expect(JSON.parse(String(fake.files.get(`${DIR}/${String(tagged.jobId)}.json`))).description).toBe('find it')
  const agentTag = parsed((await engine.start({ agent: 'code-reader', prompt: 'p', description: 'look · sonnet/medium' }, fake.host)).text)
  expect(agentTag.description).toBe('look')
  const plain = parsed((await engine.start({ agent: 'code-reader', prompt: 'p', description: 'a · b/c' }, fake.host)).text)
  expect(plain.description).toBe('a · b/c')
})

test('S: a long description is untagged before it is cut, so a copied card title does not accumulate tags; a title that is only the tag is empty', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const long = 'x'.repeat(190)
  const first = parsed((await engine.start({ agent: 'code-reader', prompt: 'p', description: `${long} · codex/medium` }, fake.host)).text)
  expect(first.description).toBe(long)
  const second = parsed((await engine.start({ agent: 'code-reader', prompt: 'p', description: 'codex/medium' }, fake.host)).text)
  expect(second).not.toHaveProperty('description')
})

test('S: a near-limit title carrying two tags is cleaned whole before the cut, in the answer and the record', async () => {
  const fake = fakeHost()
  const engine = engineOf()
  engine.useHost(fake.host)
  const long = 'y'.repeat(195)
  const answer = parsed((await engine.start({ agent: 'code-reader', prompt: 'p', description: `${long} · codex/medium · gpt-5.3-codex-max/high` }, fake.host)).text)
  expect(answer.description).toBe(long)
  expect(JSON.parse(String(fake.files.get(`${DIR}/${String(answer.jobId)}.json`))).description).toBe(long)
})
