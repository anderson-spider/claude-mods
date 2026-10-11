import { describe, expect, test } from 'claude-code/testing'
import { createJsonlReader } from '../hooks/codex/events'
import { createJobs } from '../hooks/codex/jobs'
import type { CallBase, Clock, Codec, Job, Spawn, SpawnChunk, SpawnEnd, SpawnRequest } from '../hooks/codex/jobs'
import {
  CODEX_EXEC_0_162_APPROVAL, CODEX_EXEC_0_162_FAILURE, CODEX_EXEC_0_162_INTERRUPTED, CODEX_EXEC_0_162_RESUME, CODEX_EXEC_0_162_SUCCESS,
} from './fixtures/codex-exec-0.162'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

function fakeClock() {
  let time = 1000
  const timers = new Set<{ due: number; fn: () => void }>()
  const clock: Clock = {
    now: async () => time,
    after(ms, fn) {
      const timer = { due: time + ms, fn }
      timers.add(timer)
      return { cancel: () => { timers.delete(timer) } }
    },
  }
  return {
    clock,
    pending: () => timers.size,
    async advance(ms: number) {
      const target = time + ms
      while (true) {
        const next = [...timers].filter(timer => timer.due <= target)
          .sort((a, b) => a.due - b.due)[0]
        if (!next) break
        time = next.due
        timers.delete(next)
        next.fn()
        await settle()
      }
      time = target
      await settle()
    },
  }
}

// A process whose output and exit the test drives by hand.
function controlledSpawn() {
  const queue: Array<string | SpawnChunk> = []
  let wake = deferred<void>()
  let ended = false
  let failure: unknown
  let cancels = 0
  let returned = 0
  const end = deferred<SpawnEnd>()
  const requests: SpawnRequest[] = []
  const lines: AsyncIterable<string | SpawnChunk> & AsyncIterator<string | SpawnChunk> = {
    [Symbol.asyncIterator]() { return this },
    async next() {
      while (!queue.length && !ended) {
        await wake.promise
        wake = deferred<void>()
      }
      if (failure) throw failure
      const chunk = queue.shift()
      return chunk === undefined ? { done: true, value: undefined } : { done: false, value: chunk }
    },
    return() {
      returned++
      ended = true
      queue.length = 0
      wake.resolve()
      return Promise.resolve({ done: true as const, value: undefined })
    },
  }
  const spawned = {
    lines, exit: end.promise,
    cancel() {
      cancels++
      end.resolve({ code: null, signal: 'SIGTERM' })
    },
  }
  const spawn: Spawn = request => { requests.push(request); return spawned }
  return {
    spawn, requests,
    cancels: () => cancels,
    returned: () => returned,
    text(text: string, pipe: 'stdout' | 'stderr' = 'stdout') {
      queue.push({ stream: pipe, text })
      wake.resolve()
    },
    /** One JSONL line of `codex exec --json`. */
    json(event: Record<string, unknown>) { this.text(`${JSON.stringify(event)}\n`) },
    session(id: string) { this.json({ type: 'thread.started', thread_id: id }) },
    message(text: string) { this.json({ type: 'item.completed', item: { type: 'agent_message', text } }) },
    command(command: string) { this.json({ type: 'item.started', item: { type: 'command_execution', command } }) },
    note(message: string) { this.json({ type: 'error', message }) },
    completed(usage: Record<string, number> = { input_tokens: 20, cached_input_tokens: 5, output_tokens: 10 }) {
      this.json({ type: 'turn.completed', usage })
    },
    failed(message: string) { this.json({ type: 'turn.failed', error: { message } }) },
    finish(code = 0, signal: string | null = null) {
      ended = true
      end.resolve({ code, signal })
      wake.resolve()
    },
    /** Ends the process as a spawner that knows how it ended reports it. */
    end(value: SpawnEnd) {
      ended = true
      end.resolve(value)
      wake.resolve()
    },
    fail(error: unknown) {
      failure = error
      ended = true
      end.reject(error)
      wake.resolve()
    },
  }
}

const codec: Codec = {
  buildArgv: () => ['fake-codex', 'exec', '-'],
  createJsonlReader,
}

const call: CallBase = {
  agent: 'developer', model: 'test-model', prompt: 'resolve the task', cwd: '/repo/task',
}
const foreground = { foregroundMs: 100, background: false, description: 'task description' }

function fixture(initial?: Job[], spawnOverride?: Spawn) {
  const process = controlledSpawn()
  const time = fakeClock()
  const changes: Job[][] = []
  const notifications: string[] = []
  let nextId = 0
  const jobs = createJobs({
    spawn: spawnOverride ?? process.spawn, clock: time.clock, codec,
    newId: () => `job-${++nextId}`, initial,
    onChange: value => { changes.push(value) },
    notify: text => { notifications.push(text) },
  })
  return { jobs, process, time, changes, notifications }
}

function saved(status: Job['status'], sessionId?: string): Job {
  return { id: status, agent: 'code-reader', status, startedAt: 1, cwd: '/saved/cwd', sessionId }
}

describe('codex jobs', () => {
  test('finishes in foreground on turn.completed with the last message, sessionId and usage', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.session('00000000-0000-4000-8000-0000000000a1')
    f.process.command('ls')
    f.process.message('earlier message')
    f.process.message('final answer')
    f.process.completed({ input_tokens: 20, cached_input_tokens: 5, output_tokens: 10, reasoning_output_tokens: 3 })
    await f.time.advance(25)
    f.process.finish()
    const reply = await pending
    expect(reply.outcome).toBe('done')
    expect(reply.job).toMatchObject({
      id: 'job-1', agent: 'developer', model: 'test-model', description: 'task description',
      status: 'done', sessionId: '00000000-0000-4000-8000-0000000000a1', result: 'final answer', cwd: '/repo/task',
      lastActivity: '$ ls', tokens: { input: 20, cached: 5, output: 10, reasoning: 3 },
      startedAt: 1000, endedAt: 1025,
    })
    expect(reply.job.error).toBeUndefined()
    expect(f.process.requests).toEqual([{ argv: ['fake-codex', 'exec', '-'], cwd: '/repo/task', input: 'resolve the task' }])
    expect(f.time.pending()).toBe(0)
    await f.time.advance(200)
    expect(f.notifications).toEqual([])
  })

  test('the fixture shape works with plain string chunks as well', async () => {
    const lines = ['{"type":"thread.started","thread_id":"00000000-0000-4000-8000-0000000000a3"}\n', '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n']
    const f = fixture(undefined, () => ({
      lines: (async function* () { yield* lines })(),
      exit: Promise.resolve({ code: 0, signal: null }),
      cancel() {},
    }))
    const reply = await f.jobs.run(call, foreground)
    expect(reply.outcome).toBe('done')
    expect(reply.job).toMatchObject({ sessionId: '00000000-0000-4000-8000-0000000000a3', result: 'hi' })
  })

  test('an asynchronous spawn works', async () => {
    const process = controlledSpawn()
    const f = fixture(undefined, async request => { await settle(); return process.spawn(request) })
    const pending = f.jobs.run(call, foreground)
    await settle()
    process.message('late start')
    process.completed()
    process.finish()
    const reply = await pending
    expect(reply.outcome).toBe('done')
    expect(reply.job.result).toBe('late start')
  })

  test('a turn with no agent_message still succeeds on turn.completed', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.completed()
    f.process.finish()
    const reply = await pending
    expect(reply.outcome).toBe('done')
    expect(reply.job.result).toBeUndefined()
  })

  test('a top-level error followed by turn.completed is a success', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.session('00000000-0000-4000-8000-0000000000a1')
    f.process.note('Reconnecting... 1/5')
    f.process.message('answer')
    f.process.completed()
    f.process.finish(0)
    const reply = await pending
    expect(reply.outcome).toBe('done')
    expect(reply.job.status).toBe('done')
    expect(reply.job.error).toBeUndefined()
    expect(reply.job.lastNote).toBe('Reconnecting... 1/5')
    expect(reply.job.result).toBe('answer')
  })

  test('a top-level error alone does not fail a job that exits 0 after turn.completed', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.completed()
    f.process.note('late warning')
    f.process.finish(0)
    expect((await pending).outcome).toBe('done')
  })

  test('turn.failed is an error with its message, even when the process exits 0', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.failed('turn failed: denied')
    f.process.message('partial answer')
    f.process.finish(0)
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.status).toBe('error')
    expect(reply.job.error).toBe('turn failed: denied')
    expect(reply.job.result).toBe('partial answer')
  })

  test('turn.failed with exit 1 keeps the message and adds the code', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.failed('model not found')
    f.process.finish(1)
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('model not found')
    expect(reply.job.error).toContain('code 1')
  })

  test('non-zero exit with no turn.completed is an error with the code and the last note', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.note('stream disconnected')
    f.process.finish(1)
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('code 1')
    expect(reply.job.error).toContain('without turn.completed')
    expect(reply.job.error).toContain('stream disconnected')
  })

  test('non-zero exit after turn.completed is still an error, result kept', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.message('partial answer')
    f.process.completed()
    f.process.finish(3)
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('code 3')
    expect(reply.job.result).toBe('partial answer')
  })

  test('exit 0 with no terminal event is an error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.message('looked done')
    f.process.finish()
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('without turn.completed')
  })

  test('an interrupted turn (SIGINT, no terminal event) is cancelled, not an error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.session('00000000-0000-4000-8000-0000000000a1')
    f.process.message('half way')
    f.process.finish(0, 'SIGINT')
    const reply = await pending
    expect(reply.outcome).toBe('cancelled')
    expect(reply.job).toMatchObject({ status: 'cancelled', sessionId: '00000000-0000-4000-8000-0000000000a1', result: 'half way' })
    expect(reply.job.error).toBeUndefined()
  })

  test('turn.started then exit 1 with no terminal event is cancelled only when the spawner sent the interrupt', async () => {
    for (const [interrupted, outcome] of [[true, 'cancelled'], [false, 'error'], [undefined, 'error']] as const) {
      const f = fixture()
      const pending = f.jobs.run(call, foreground)
      await settle()
      f.process.session('00000000-0000-4000-8000-0000000000a1')
      f.process.json({ type: 'turn.started' })
      f.process.end({ code: 1, signal: null, ...(interrupted === undefined ? {} : { interrupted }) })
      expect((await pending).outcome).toBe(outcome)
    }
  })

  test('turn.started then exit 1 with an error note is an error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.json({ type: 'turn.started' })
    f.process.note('stream disconnected')
    f.process.finish(1)
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('stream disconnected')
  })

  test('turn.started, a warning item, then an interrupted exit 1 with no terminal event is cancelled', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.json({ type: 'turn.started' })
    f.process.json({ type: 'item.completed', item: { type: 'error', message: 'Model metadata not found' } })
    f.process.end({ code: 1, signal: null, interrupted: true })
    const reply = await pending
    expect(reply.outcome).toBe('cancelled')
    expect(reply.job.lastNote).toBeUndefined()
  })

  test('turn.started, a top-level error, then exit 1 is an error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.json({ type: 'turn.started' })
    f.process.json({ type: 'item.completed', item: { type: 'error', message: 'a warning' } })
    f.process.note('fatal')
    f.process.finish(1)
    expect((await pending).outcome).toBe('error')
  })

  test('turn.started then exit 0 with no terminal event is an error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.json({ type: 'turn.started' })
    f.process.finish(0)
    expect((await pending).outcome).toBe('error')
  })

  test('turn.started then exit 101 (a panic) or 2 is an error', async () => {
    for (const code of [101, 2]) {
      const f = fixture()
      const pending = f.jobs.run(call, foreground)
      await settle()
      f.process.json({ type: 'turn.started' })
      f.process.finish(code)
      const reply = await pending
      expect(reply.outcome).toBe('error')
      expect(reply.job.error).toContain(`code ${code}`)
    }
  })

  test('exit 1 without turn.started and without a terminal event is an error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.session('00000000-0000-4000-8000-0000000000a1')
    f.process.finish(1)
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('code 1')
  })

  test('turn.started then a kill signal other than SIGINT is an error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.json({ type: 'turn.started' })
    f.process.finish(0, 'SIGTERM')
    expect((await pending).outcome).toBe('error')
  })

  test('exit code 130 alone is not an interrupt: the spawner says whether it sent one', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.finish(130)
    expect((await pending).outcome).toBe('error')
  })

  test('a lost process (no exit code) with no terminal event is lost; an interrupt sent before wins', async () => {
    for (const [interrupted, status] of [[false, 'lost'], [true, 'cancelled']] as const) {
      const f = fixture()
      const pending = f.jobs.run(call, foreground)
      await settle()
      f.process.json({ type: 'turn.started' })
      f.process.end({ code: null, signal: null, lost: true, interrupted })
      expect((await pending).job.status).toBe(status)
    }
  })

  test('another signal with no terminal event (a kill on unload) is an error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.finish(0, 'SIGTERM')
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('SIGTERM')
  })

  test('a signal after turn.completed is still an error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.completed()
    f.process.finish(null as unknown as number, 'SIGKILL')
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('SIGKILL')
  })

  test('exceeds foregroundMs -> background, then notify on finish with the id and status only', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    await f.time.advance(99)
    expect(f.jobs.list()[0]?.status).toBe('running')
    await f.time.advance(1)
    const reply = await pending
    expect(reply.outcome).toBe('background')
    expect(reply.job.status).toBe('background')
    expect(f.notifications).toEqual([])
    f.process.message('finished later')
    f.process.completed()
    f.process.finish()
    await settle()
    expect(f.jobs.get(reply.job.id)?.status).toBe('done')
    expect(f.notifications).toHaveLength(1)
    expect(f.notifications[0]).toContain(reply.job.id)
    expect(f.notifications[0]).toContain('codex_result')
    expect(f.notifications[0]).not.toContain('finished later')
  })

  test('background:true returns immediately', async () => {
    const f = fixture()
    const reply = await f.jobs.run(call, { ...foreground, background: true })
    expect(reply.outcome).toBe('background')
    expect(reply.job.status).toBe('background')
    expect(f.time.pending()).toBe(0)
    f.process.message('answer')
    f.process.completed()
    f.process.finish()
    await settle()
    expect(f.jobs.get(reply.job.id)?.result).toBe('answer')
    expect(f.notifications).toHaveLength(1)
  })

  test('error includes the last stderr lines', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.text('first diagnostic\nlast diagno', 'stderr')
    f.process.text('stic\n', 'stderr')
    f.process.finish(2)
    const reply = await pending
    expect(reply.job.error).toContain('last diagnostic')
    expect(reply.job.error).toContain('code 2')
  })

  test('spawn failure -> error instead of rejected run', async () => {
    const f = fixture(undefined, () => { throw new Error('cannot start') })
    const reply = await f.jobs.run(call, foreground)
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('cannot start')
    expect(f.time.pending()).toBe(0)
  })

  test('asynchronous spawn failure -> error', async () => {
    const f = fixture(undefined, async () => { throw new Error('cannot start async') })
    const reply = await f.jobs.run(call, foreground)
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('cannot start async')
  })

  test('background spawn failure returns a consistent error outcome', async () => {
    const f = fixture(undefined, () => { throw new Error('cannot start background') })
    const reply = await f.jobs.run(call, { ...foreground, background: true })
    expect(reply.outcome).toBe('error')
    expect(reply.job.status).toBe('error')
    expect(reply.job.error).toContain('cannot start background')
    expect(f.notifications).toHaveLength(1)
    expect(f.notifications[0]).toContain('error')
  })

  test('stream and exit failure -> error without hanging', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.fail(new Error('stream unavailable'))
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('stream unavailable')
  })

  test('resumeTarget: unknown, still active, without sessionId -> error', () => {
    const f = fixture([saved('running', 'r'), saved('background', 'b'), saved('lost')])
    expect(f.jobs.resumeTarget('unknown')).toHaveProperty('error')
    expect(f.jobs.resumeTarget('running')).toHaveProperty('error')
    expect(f.jobs.resumeTarget('background')).toHaveProperty('error')
    const target = f.jobs.resumeTarget('lost')
    expect(target).toHaveProperty('error')
    if ('error' in target) expect(target.error).toContain('delegate it again')
  })

  test('resumeTarget: done/cancelled/lost/error with sessionId -> sessionId, cwd, agent', () => {
    const f = fixture(['done', 'cancelled', 'lost', 'error'].map(status => saved(status as Job['status'], `thread-${status}`)))
    for (const status of ['done', 'cancelled', 'lost', 'error']) {
      expect(f.jobs.resumeTarget(status)).toEqual({ sessionId: `thread-${status}`, cwd: '/saved/cwd', agent: 'code-reader' })
    }
  })

  test('resumeTarget refuses a session already resumed by an active job', async () => {
    const f = fixture([saved('done', '00000000-0000-4000-8000-0000000000a2')])
    void f.jobs.run({ ...call, resumeSessionId: '00000000-0000-4000-8000-0000000000a2' }, { ...foreground, background: true })
    await settle()
    expect(f.jobs.resumeTarget('done')).toEqual({ error: expect.stringContaining('already in use') })
  })

  test('cancel stops the process and marks cancelled; a late result does not overwrite it', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    expect(f.jobs.cancel('job-1')).toMatchObject({ status: 'cancelled' })
    expect(f.process.cancels()).toBe(1)
    expect(f.process.returned()).toBe(1)
    f.process.message('too late')
    f.process.completed()
    f.process.finish()
    const reply = await pending
    expect(reply.outcome).toBe('cancelled')
    expect(reply.job.endedAt).toBe(1000)
    expect(f.jobs.get('job-1')?.status).toBe('cancelled')
    expect(f.jobs.get('job-1')?.result).toBeUndefined()
    expect(f.jobs.cancel('job-1')).toMatchObject({ status: 'cancelled' })
    expect(f.process.cancels()).toBe(1)
    expect(f.jobs.cancel('unknown')).toHaveProperty('error')
    expect(f.time.pending()).toBe(0)
  })

  test('cancel while an asynchronous spawn is still starting cancels the process once it exists', async () => {
    const process = controlledSpawn()
    const start = deferred<void>()
    const f = fixture(undefined, async request => { await start.promise; return process.spawn(request) })
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.jobs.cancel('job-1')
    start.resolve()
    expect((await pending).outcome).toBe('cancelled')
    await settle()
    expect(process.cancels()).toBe(1)
  })

  test('cancel of a job with no live process (loaded as active) is an error', () => {
    const f = fixture([saved('running', 'r')])
    expect(f.jobs.cancel('running')).toHaveProperty('error')
  })

  test('abort signal in foreground cancels the process', async () => {
    const f = fixture()
    const controller = new AbortController()
    const pending = f.jobs.run(call, { ...foreground, signal: controller.signal })
    await settle()
    controller.abort()
    expect((await pending).outcome).toBe('cancelled')
    expect(f.process.cancels()).toBe(1)
  })

  test('already aborted foreground never spawns', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    const reply = await f.jobs.run(call, { ...foreground, signal: controller.signal })
    expect(reply.outcome).toBe('cancelled')
    expect(f.process.requests).toEqual([])
  })

  test('foreground signal no longer cancels after switching to background', async () => {
    const f = fixture()
    const controller = new AbortController()
    const pending = f.jobs.run(call, { ...foreground, signal: controller.signal })
    await settle()
    await f.time.advance(100)
    const reply = await pending
    controller.abort()
    expect(f.process.cancels()).toBe(0)
    expect(f.jobs.get(reply.job.id)?.status).toBe('background')
    f.process.message('background survived')
    f.process.completed()
    f.process.finish()
    await settle()
    expect(f.jobs.get(reply.job.id)?.status).toBe('done')
  })

  test('cancelled background notifies once and never becomes done', async () => {
    const f = fixture()
    const reply = await f.jobs.run(call, { ...foreground, background: true })
    f.jobs.cancel(reply.job.id)
    f.process.completed()
    f.process.finish()
    await settle()
    expect(f.jobs.get(reply.job.id)?.status).toBe('cancelled')
    expect(f.notifications).toHaveLength(1)
    expect(f.notifications[0]).toContain('cancelled')
  })

  test('onChange receives every status transition', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.session('00000000-0000-4000-8000-0000000000a1')
    await settle()
    expect(f.changes.at(-1)?.[0]?.sessionId).toBe('00000000-0000-4000-8000-0000000000a1')
    await f.time.advance(100)
    await pending
    f.process.message('complete')
    f.process.completed()
    f.process.finish()
    await settle()
    const transitions = f.changes.map(jobs => jobs[0]?.status)
      .filter((status, index, all) => index === 0 || status !== all[index - 1])
    expect(transitions).toEqual(['running', 'background', 'done'])
    expect(f.changes[0]?.[0]?.sessionId).toBeUndefined()
    expect(f.jobs.list()).toHaveLength(1)
    expect(f.jobs.get('unknown')).toBeUndefined()
  })

  test('list and get return copies', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.completed()
    f.process.finish()
    await pending
    const job = f.jobs.get('job-1')!
    job.status = 'error'
    if (job.tokens) job.tokens.input = 999
    expect(f.jobs.get('job-1')?.status).toBe('done')
    expect(f.jobs.get('job-1')?.tokens?.input).toBe(20)
  })
})

// Independent verification: outcome rules, cancel first-wins, background notice, answers, lost and resume,
// and the 0.162.1 T0 fixtures fed through reader, parser and job.
function replay(jsonl: string, end: SpawnEnd, stderr = '', size = 7): Spawn {
  return () => ({
    lines: (async function* () {
      for (let i = 0; i < jsonl.length; i += size) yield { stream: 'stdout' as const, text: jsonl.slice(i, i + size) }
      if (stderr) yield { stream: 'stderr' as const, text: stderr }
    })(),
    exit: Promise.resolve(end),
    cancel() {},
  })
}

describe('codex jobs: outcome', () => {
  test('a non-zero exit without a terminal event names the code', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.finish(2)
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('code 2')
  })

  test('SIGINT after turn.failed is the failure, not a cancel', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.failed('quota')
    f.process.finish(null as unknown as number, 'SIGINT')
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('quota')
  })
})

describe('codex jobs: cancel first-wins', () => {
  test('a late exit rejection or stream failure after cancel leaves cancelled, without an error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.jobs.cancel('job-1')
    f.process.fail(new Error('stream broke'))
    const reply = await pending
    await settle()
    expect(reply.outcome).toBe('cancelled')
    expect(f.jobs.get('job-1')).toMatchObject({ status: 'cancelled' })
    expect(f.jobs.get('job-1')?.error).toBeUndefined()
  })

  test('cancel twice while the spawn is starting kills the process once', async () => {
    const process = controlledSpawn()
    const start = deferred<void>()
    const f = fixture(undefined, async request => { await start.promise; return process.spawn(request) })
    const pending = f.jobs.run(call, foreground)
    await settle()
    expect(f.jobs.cancel('job-1')).toMatchObject({ status: 'cancelled' })
    expect(f.jobs.cancel('job-1')).toMatchObject({ status: 'cancelled' })
    start.resolve()
    expect((await pending).outcome).toBe('cancelled')
    await settle()
    expect(process.cancels()).toBe(1)
    process.completed()
    process.finish()
    await settle()
    expect(f.jobs.get('job-1')?.status).toBe('cancelled')
  })

  test('a teardown that throws still leaves the job cancelled', async () => {
    const process = controlledSpawn()
    const f = fixture(undefined, request => ({ ...process.spawn(request) as ReturnType<typeof process.spawn> & object, cancel() { throw new Error('kill failed') } }))
    const pending = f.jobs.run(call, foreground)
    await settle()
    expect(f.jobs.cancel('job-1')).toMatchObject({ status: 'cancelled' })
    expect((await pending).outcome).toBe('cancelled')
  })

  test('cancel after the foreground turned background notifies once with cancelled', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    await f.time.advance(100)
    expect((await pending).outcome).toBe('background')
    f.jobs.cancel('job-1')
    f.process.message('late')
    f.process.completed()
    f.process.finish()
    await settle()
    expect(f.jobs.get('job-1')).toMatchObject({ status: 'cancelled' })
    expect(f.jobs.get('job-1')?.result).toBeUndefined()
    expect(f.notifications).toHaveLength(1)
    expect(f.notifications[0]).toContain('cancelled')
  })
})

describe('codex jobs: background notice', () => {
  test('a background job that fails notifies once with the id and status, without Codex output or stderr', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    await f.time.advance(100)
    expect((await pending).outcome).toBe('background')
    f.process.message('SECRET ANSWER')
    f.process.text('SECRET STDERR\n', 'stderr')
    f.process.failed('SECRET FAILURE')
    f.process.finish(1)
    await settle()
    await f.time.advance(1000)
    expect(f.jobs.get('job-1')?.status).toBe('error')
    expect(f.notifications).toHaveLength(1)
    expect(f.notifications[0]).toContain('job-1')
    expect(f.notifications[0]).toContain('error')
    expect(f.notifications[0]).not.toContain('SECRET')
  })

  test('a job that ends in the foreground never notifies', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.failed('boom')
    f.process.finish(1)
    expect((await pending).outcome).toBe('error')
    await f.time.advance(1000)
    expect(f.notifications).toEqual([])
  })
})

describe('codex jobs: answer', () => {
  test('the answer is the last completed agent_message; started and updated ones never overwrite it', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.message('first')
    f.process.message('final')
    f.process.json({ type: 'item.started', item: { type: 'agent_message', text: 'streaming' } })
    f.process.json({ type: 'item.updated', item: { type: 'agent_message', text: 'streaming more' } })
    f.process.completed()
    f.process.finish()
    const reply = await pending
    expect(reply.outcome).toBe('done')
    expect(reply.job.result).toBe('final')
  })
})

describe('codex jobs: lost and resume', () => {
  test('a lost job with a session is resumable; one without a session is not', () => {
    const f = fixture([{ ...saved('lost', 'r'), id: 'with' }, { ...saved('lost'), id: 'without' }])
    expect(f.jobs.resumeTarget('with')).toEqual({ sessionId: 'r', cwd: '/saved/cwd', agent: 'code-reader' })
    expect(f.jobs.resumeTarget('without')).toEqual({ error: expect.stringContaining('before Codex opened its session') })
  })

  test('an active job refuses resume, and so does an ended one whose session a new run picked up', async () => {
    const f = fixture([saved('done', '00000000-0000-4000-8000-0000000000a2')])
    const pending = f.jobs.run(call, foreground)
    await settle()
    expect(f.jobs.resumeTarget('job-1')).toEqual({ error: expect.stringContaining('still active') })
    f.process.session('00000000-0000-4000-8000-0000000000a2')
    await settle()
    expect(f.jobs.resumeTarget('done')).toEqual({ error: expect.stringContaining('job-1') })
    f.process.completed()
    f.process.finish()
    await pending
    expect(f.jobs.resumeTarget('done')).toEqual({ sessionId: '00000000-0000-4000-8000-0000000000a2', cwd: '/saved/cwd', agent: 'code-reader' })
  })
})

describe('codex jobs: 0.162.1 fixtures end to end', () => {
  test('success (exit 0) -> done with the last answer, session and usage', async () => {
    const fx = CODEX_EXEC_0_162_SUCCESS
    const f = fixture(undefined, replay(fx.jsonl, { code: fx.exit, signal: null }, fx.stderr))
    const reply = await f.jobs.run(call, foreground)
    expect(reply.outcome).toBe('done')
    expect(reply.job).toMatchObject({
      sessionId: '01a12bd5-30e4-7f12-8e42-d8db931e560d',
      result: 'Neste diretório:\n\n- `a.txt`\n- `.codegraph/`\n- `.crew/`\n- `.git/`',
      tokens: { input: 49250, cached: 37632, output: 73, reasoning: 0, cacheWrite: 0 },
    })
    expect(reply.job.error).toBeUndefined()
  })

  test('failure (turn.failed, exit 1) -> error with the turn message and the code', async () => {
    const fx = CODEX_EXEC_0_162_FAILURE
    const f = fixture(undefined, replay(fx.jsonl, { code: fx.exit, signal: null }, fx.stderr))
    const reply = await f.jobs.run(call, foreground)
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('does-not-exist')
    expect(reply.job.error).toContain('code 1')
  })

  test('resume (exit 0) -> done on the same session id as the run it resumed', async () => {
    const first = fixture(undefined, replay(CODEX_EXEC_0_162_SUCCESS.jsonl, { code: 0, signal: null }))
    const original = await first.jobs.run(call, foreground)
    const target = first.jobs.resumeTarget(original.job.id)
    expect(target).toMatchObject({ sessionId: '01a12bd5-30e4-7f12-8e42-d8db931e560d' })
    const fx = CODEX_EXEC_0_162_RESUME
    const reply = await first.jobs.run(
      { ...call, resumeSessionId: (target as { sessionId: string }).sessionId },
      { ...foreground, spawn: replay(fx.jsonl, { code: fx.exit, signal: null }, fx.stderr) },
    )
    expect(reply.outcome).toBe('done')
    expect(reply.job.sessionId).toBe(original.job.sessionId)
    expect(reply.job.result).toContain('List the files in this directory')
  })

  test('approval: a failed command item, then its retry and turn.completed (exit 0) -> done, not error', async () => {
    const fx = CODEX_EXEC_0_162_APPROVAL
    const f = fixture(undefined, replay(fx.jsonl, { code: fx.exit, signal: null }))
    const reply = await f.jobs.run(call, foreground)
    expect(reply.outcome).toBe('done')
    expect(reply.job.error).toBeUndefined()
    expect(reply.job.result).toBe('Linha de status: `HTTP/2 200`.')
    expect(reply.job.tokens).toEqual({ input: 56960, cached: 49792, output: 142, reasoning: 9, cacheWrite: 0 })
  })

  test('interrupted, as reported by a signal (SIGINT, no terminal event) -> cancelled', async () => {
    const fx = CODEX_EXEC_0_162_INTERRUPTED
    const f = fixture(undefined, replay(fx.jsonl, { code: null, signal: 'SIGINT' }, fx.stderr))
    const reply = await f.jobs.run(call, foreground)
    expect(reply.outcome).toBe('cancelled')
    expect(reply.job.sessionId).toBe('01a12bd5-9d50-7dc2-a785-4ed4ecc5f924')
  })

  // As recorded: Codex handles SIGINT itself (TurnInterrupt) and exits 1, not 130 and not on a signal; the crew's
  // tail reports `interrupted` when it sent that SIGINT.
  test('interrupted, as recorded (SIGINT handled by Codex, exit 1, no terminal event) -> cancelled', async () => {
    const fx = CODEX_EXEC_0_162_INTERRUPTED
    const f = fixture(undefined, replay(fx.jsonl, { code: fx.exit, signal: null, interrupted: true }, fx.stderr))
    const reply = await f.jobs.run(call, foreground)
    expect(reply.outcome).toBe('cancelled')
  })

  test('the same recording without an interrupt from the crew (a crash after turn.started) -> error', async () => {
    const fx = CODEX_EXEC_0_162_INTERRUPTED
    const f = fixture(undefined, replay(fx.jsonl, { code: fx.exit, signal: null, interrupted: false }, fx.stderr))
    const reply = await f.jobs.run(call, foreground)
    expect(reply.outcome).toBe('error')
  })
})

describe('codex jobs: the interrupt rule at its edges', () => {
  // A warning comes as an `error` item (research: "warnings/deprecations come as items of type error"); the failure
  // fixture opens with two of them. A warning seen before a handled SIGINT should not make the interrupt an error.
  test('interrupted, as recorded, after a warning item -> cancelled', async () => {
    const fx = CODEX_EXEC_0_162_INTERRUPTED
    const warning = `${JSON.stringify({ type: 'item.completed', item: { id: 'item_w', type: 'error', message: 'Model metadata for `x` not found. Defaulting to fallback metadata.' } })}\n`
    const [first, ...rest] = fx.jsonl.split('\n')
    const f = fixture(undefined, replay([first, warning.trimEnd(), ...rest].join('\n'), { code: fx.exit, signal: null, interrupted: true }, fx.stderr))
    const reply = await f.jobs.run(call, foreground)
    expect(reply.outcome).toBe('cancelled')
  })

  test('an interrupted background job notifies once with cancelled and stays resumable', async () => {
    const fx = CODEX_EXEC_0_162_INTERRUPTED
    const f = fixture(undefined, replay(fx.jsonl, { code: fx.exit, signal: null, interrupted: true }, fx.stderr))
    const reply = await f.jobs.run(call, { ...foreground, background: true })
    expect(reply.outcome).toBe('background')
    // The replay yields about 60 chunks; let them all drain.
    for (let i = 0; i < 20; i++) await settle()
    expect(f.jobs.get(reply.job.id)?.status).toBe('cancelled')
    expect(f.notifications).toHaveLength(1)
    expect(f.notifications[0]).toContain('cancelled')
    expect(f.jobs.resumeTarget(reply.job.id)).toMatchObject({ sessionId: '01a12bd5-9d50-7dc2-a785-4ed4ecc5f924' })
  })
})

describe('codex jobs: graceful cancel', () => {
  const graceful = { ...foreground, background: true, gracefulCancel: true }

  /** The controlled process, whose cancel only asks (a SIGINT): it ends when the test ends it. */
  function asking(gate?: Promise<void>) {
    const process = controlledSpawn()
    let asks = 0
    const spawn: Spawn = async request => {
      if (gate) await gate
      const spawned = await process.spawn(request)
      return { ...spawned, cancel: () => { asks++ } }
    }
    return { process, spawn, asks: () => asks }
  }

  test('a cancel asks the process once and the job stays active, marked cancelling, until the process ends', async () => {
    const p = asking()
    const f = fixture(undefined, p.spawn)
    const reply = await f.jobs.run(call, graceful)
    await settle()
    p.process.json({ type: 'turn.started' })
    await settle()
    f.jobs.cancel(reply.job.id)
    f.jobs.cancel(reply.job.id)
    await settle()
    expect(p.asks()).toBe(1)
    expect(f.jobs.get(reply.job.id)).toMatchObject({ status: 'background', cancelling: true })
    expect(f.notifications).toEqual([])

    p.process.end({ code: 1, signal: null, interrupted: true })
    for (let i = 0; i < 5; i++) await settle()
    expect(f.jobs.get(reply.job.id)?.status).toBe('cancelled')
    expect(f.notifications).toHaveLength(1)
  })

  test('a cancel while the spawn is still starting reaches the process once it exists', async () => {
    const gate = deferred<void>()
    const p = asking(gate.promise)
    const f = fixture(undefined, p.spawn)
    const reply = await f.jobs.run(call, graceful)
    f.jobs.cancel(reply.job.id)
    expect(p.asks()).toBe(0)
    gate.resolve()
    for (let i = 0; i < 3; i++) await settle()
    expect(p.asks()).toBe(1)
  })

  test('a foreground run whose signal is already aborted ends cancelled at once and spawns nothing', async () => {
    let spawned = 0
    const spawn: Spawn = async () => { spawned++; throw new Error('must not spawn') }
    const f = fixture(undefined, spawn)
    const signal = { aborted: true, addEventListener: () => {}, removeEventListener: () => {} } as unknown as AbortSignal
    const reply = await f.jobs.run(call, { ...foreground, gracefulCancel: true, signal })
    for (let i = 0; i < 3; i++) await settle()
    expect(reply.outcome).toBe('cancelled')
    expect(f.jobs.get(reply.job.id)?.status).toBe('cancelled')
    expect(spawned).toBe(0)
    expect(f.notifications).toEqual([])
  })

  test('a job that completes after the cancel was asked is done, not cancelled', async () => {
    const p = asking()
    const f = fixture(undefined, p.spawn)
    const reply = await f.jobs.run(call, graceful)
    await settle()
    f.jobs.cancel(reply.job.id)
    p.process.completed()
    p.process.end({ code: 0, signal: null, interrupted: false })
    for (let i = 0; i < 5; i++) await settle()
    expect(f.jobs.get(reply.job.id)?.status).toBe('done')
  })
})
