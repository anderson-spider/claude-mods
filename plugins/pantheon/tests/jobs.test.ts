import { describe, expect, test } from 'claude-code/testing'
import { createJobs, markLost } from '../hooks/jobs'
import type { Clock, Codec, CodexCall, CodexEvent, Job, Spawn, SpawnChunk, SpawnEnd } from '../hooks/types'

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

function controlledSpawn() {
  const queue: SpawnChunk[] = []
  let wake = deferred<void>()
  let ended = false
  let failure: unknown
  let returned = 0
  const end = deferred<SpawnEnd>()
  const requests: Parameters<Spawn>[0][] = []
  const stream = {
    result: end.promise,
    [Symbol.asyncIterator]() { return this },
    async next(): Promise<IteratorResult<SpawnChunk>> {
      while (!queue.length && !ended) {
        await wake.promise
        wake = deferred<void>()
      }
      if (failure) throw failure
      const chunk = queue.shift()
      return chunk ? { done: false, value: chunk } : { done: true, value: undefined }
    },
    return() {
      returned++
      ended = true
      queue.length = 0
      end.resolve({ code: null, signal: 'SIGTERM' })
      wake.resolve()
      return Promise.resolve({ done: true as const, value: undefined })
    },
  }
  const spawn: Spawn = request => { requests.push(request); return stream }
  return {
    spawn, requests,
    returned: () => returned,
    chunk(text: string, pipe: 'stdout' | 'stderr' = 'stdout') {
      queue.push({ stream: pipe, text })
      wake.resolve()
    },
    event(event: CodexEvent) { this.chunk(`ev:${JSON.stringify(event)}\n`) },
    finish(code = 0, signal: string | null = null) {
      ended = true
      end.resolve({ code, signal })
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
  createJsonlReader() {
    let buffer = ''
    const parse = (line: string): CodexEvent[] => line.startsWith('ev:')
      ? [JSON.parse(line.slice(3)) as CodexEvent] : []
    return {
      push(text) {
        buffer += text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        return lines.flatMap(parse)
      },
      end() { const events = parse(buffer); buffer = ''; return events },
    }
  },
}

const call: CodexCall = {
  agent: 'executor', model: 'test-model', sandbox: 'workspace-write', noNetwork: false,
  prompt: 'resolve the task', cwd: '/repo/task', skipGitRepoCheck: false,
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
  return { id: status, agent: 'explorer', status, startedAt: 1, cwd: '/saved/cwd', sessionId }
}

describe('jobs', () => {
  test('finishes in foreground with final message and sessionId', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.event({ kind: 'session', sessionId: 'thread-1' })
    f.process.event({ kind: 'activity', text: 'reading files' })
    f.process.event({ kind: 'message', text: 'earlier message' })
    f.process.event({ kind: 'usage', tokens: { input: 20, cached: 5, output: 10 } })
    f.process.chunk(`ev:${JSON.stringify({ kind: 'message', text: 'final answer' })}`)
    await f.time.advance(25)
    f.process.finish()
    const reply = await pending
    expect(reply.outcome).toBe('done')
    expect(reply.job).toMatchObject({
      id: 'job-1', agent: 'executor', model: 'test-model', description: 'task description',
      status: 'done', sessionId: 'thread-1', result: 'final answer', cwd: '/repo/task',
      lastActivity: 'reading files', tokens: { input: 20, cached: 5, output: 10 },
      startedAt: 1000, endedAt: 1025,
    })
    expect(f.process.requests).toEqual([{ argv: ['fake-codex', 'exec', '-'], cwd: '/repo/task', input: 'resolve the task' }])
    expect(f.time.pending()).toBe(0)
    await f.time.advance(200)
    expect(f.notifications).toEqual([])
  })

  test('exceeds foregroundMs -> background, then notify on finish', async () => {
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
    f.process.event({ kind: 'message', text: 'finished later' })
    f.process.finish()
    await settle()
    expect(f.jobs.get(reply.job.id)?.status).toBe('done')
    expect(f.notifications).toHaveLength(1)
    expect(f.notifications[0]).toContain(reply.job.id)
    expect(f.notifications[0]).toContain('delegate_result')
  })

  test('background:true returns immediately', async () => {
    const f = fixture()
    const reply = await f.jobs.run(call, { ...foreground, background: true })
    expect(reply.outcome).toBe('background')
    expect(reply.job.status).toBe('background')
    expect(f.time.pending()).toBe(0)
    f.process.event({ kind: 'message', text: 'answer' })
    f.process.finish()
    await settle()
    expect(f.jobs.get(reply.job.id)?.result).toBe('answer')
    expect(f.notifications).toHaveLength(1)
  })

  test('non-zero exit with no message -> error with code', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.finish(2)
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.status).toBe('error')
    expect(reply.job.error).toContain('code 2')
  })

  test('non-zero exit after a message -> error, message kept in result', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.event({ kind: 'message', text: 'partial answer' })
    f.process.finish(3)
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('code 3')
    expect(reply.job.result).toBe('partial answer')
  })

  test('turn.failed then exit 0 -> error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.event({ kind: 'failed', error: 'turn failed: denied' })
    f.process.event({ kind: 'message', text: 'partial answer' })
    f.process.finish()
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('denied')
    expect(reply.job.result).toBe('partial answer')
  })

  test('exit 0 without agent_message -> error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.finish()
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toBeTruthy()
  })

  test('empty final message -> error', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.event({ kind: 'message', text: '  ' })
    f.process.finish()
    expect((await pending).outcome).toBe('error')
  })

  test('error includes the last stderr lines', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.chunk('first diagnostic\nlast diagno', 'stderr')
    f.process.chunk('stic\n', 'stderr')
    f.process.finish(2)
    const reply = await pending
    expect(reply.job.error).toContain('last diagnostic')
    expect(reply.job.error).toContain('code 2')
  })

  test('signal exit -> error with signal', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.finish(0, 'SIGTERM')
    const reply = await pending
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('SIGTERM')
  })

  test('spawn failure -> error instead of rejected run', async () => {
    const f = fixture(undefined, () => { throw new Error('cannot start') })
    const reply = await f.jobs.run(call, foreground)
    expect(reply.outcome).toBe('error')
    expect(reply.job.error).toContain('cannot start')
    expect(f.time.pending()).toBe(0)
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

  test('stream and result failure -> error without hanging', async () => {
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

  test('resumeTarget: done/cancelled/lost with sessionId -> sessionId, cwd, agent', () => {
    const f = fixture(['done', 'cancelled', 'lost', 'error'].map(status => saved(status as Job['status'], `thread-${status}`)))
    for (const status of ['done', 'cancelled', 'lost', 'error']) {
      expect(f.jobs.resumeTarget(status)).toEqual({ sessionId: `thread-${status}`, cwd: '/saved/cwd', agent: 'explorer' })
    }
  })

  test('resumeTarget refuses a session already resumed by an active job', async () => {
    const f = fixture([saved('done', 'thread-x')])
    void f.jobs.run({ ...call, resumeSessionId: 'thread-x' }, { ...foreground, background: true })
    await settle()
    expect(f.jobs.resumeTarget('done')).toEqual({ error: expect.stringContaining('already in use') })
  })

  test('cancel kills process and marks cancelled', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    expect(f.jobs.cancel('job-1')).toMatchObject({ status: 'cancelled' })
    expect(f.process.returned()).toBe(1)
    const reply = await pending
    expect(reply.outcome).toBe('cancelled')
    expect(reply.job.endedAt).toBe(1000)
    expect(f.jobs.cancel('job-1')).toMatchObject({ status: 'cancelled' })
    expect(f.process.returned()).toBe(1)
    expect(f.jobs.cancel('unknown')).toHaveProperty('error')
    expect(f.time.pending()).toBe(0)
  })

  test('abort signal in foreground kills process', async () => {
    const f = fixture()
    const controller = new AbortController()
    const pending = f.jobs.run(call, { ...foreground, signal: controller.signal })
    await settle()
    controller.abort()
    expect((await pending).outcome).toBe('cancelled')
    expect(f.process.returned()).toBe(1)
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
    expect(f.process.returned()).toBe(0)
    expect(f.jobs.get(reply.job.id)?.status).toBe('background')
    f.process.event({ kind: 'message', text: 'background survived' })
    f.process.finish()
    await settle()
    expect(f.jobs.get(reply.job.id)?.status).toBe('done')
  })

  test('cancelled background notifies once and never becomes done', async () => {
    const f = fixture()
    const reply = await f.jobs.run(call, { ...foreground, background: true })
    f.jobs.cancel(reply.job.id)
    await settle()
    expect(f.jobs.get(reply.job.id)?.status).toBe('cancelled')
    expect(f.notifications).toHaveLength(1)
    expect(f.notifications[0]).toContain('cancelled')
  })

  test('markLost turns running and background into lost, keeps sessionId', () => {
    const initial = [saved('running', 'r'), saved('background', 'b'), saved('done', 'd'), saved('error'), saved('cancelled'), saved('lost')]
    const lost = markLost(initial)
    expect(lost.map(job => job.status)).toEqual(['lost', 'lost', 'done', 'error', 'cancelled', 'lost'])
    expect(lost[0]?.sessionId).toBe('r')
    expect(lost[1]?.sessionId).toBe('b')
    expect(initial[0]?.status).toBe('running')
    expect(initial[1]?.status).toBe('background')
  })

  test('onChange receives every status transition', async () => {
    const f = fixture()
    const pending = f.jobs.run(call, foreground)
    await settle()
    f.process.event({ kind: 'session', sessionId: 'thread-1' })
    await settle()
    expect(f.changes.at(-1)?.[0]?.sessionId).toBe('thread-1')
    await f.time.advance(100)
    await pending
    f.process.event({ kind: 'message', text: 'complete' })
    f.process.finish()
    await settle()
    const transitions = f.changes.map(jobs => jobs[0]?.status)
      .filter((status, index, all) => index === 0 || status !== all[index - 1])
    expect(transitions).toEqual(['running', 'background', 'done'])
    expect(f.changes[0]?.[0]?.sessionId).toBeUndefined()
    expect(f.jobs.list()).toHaveLength(1)
    expect(f.jobs.get('unknown')).toBeUndefined()
  })
})
