import { expect, test } from 'claude-code/testing'
import { autoFinish, dispatch } from '../hooks/team'
import { createAutoCloser, readyReport } from '../hooks/auto-close'
import type { Tracked } from '../hooks/auto-close'
import { effectiveName } from '../hooks/names'
import { lifecycle, COMPLETE, REVIEW, UUID } from './lifecycle'

const report = (role = 'developer') => `/home/u/.claude/codex-team/reports/repo/1r/fix-${role}.md`
const entry = (over: Partial<Tracked> = {}): Tracked => ({ workspace: 'w1', effectiveAgent: effectiveName('dev-fix', 'w1')!, pane: 'w1:p1', uuid: UUID, role: 'developer', report: report(), submittedAt: 1_000, baselineMtime: 0, ...over })

test('identity is captured after the prompt is confirmed, when the Codex session id first exists', async () => {
  const w = lifecycle(), run = w.io.run
  const events: string[] = []
  w.put(report(), COMPLETE, 1_500)
  const stat = w.io.reports!.stat
  w.io.reports!.stat = async path => { events.push('stat'); return stat(path) }
  w.io.run = async (argv, init) => {
    if (argv[2] === 'get') events.push('identity')
    if (argv[2] === 'prompt') {
      expect(w.state.agents[0]!.agent_session).toBeUndefined()
      events.push('prompt')
      // A report completed during prompt delivery must remain newer than the pre-prompt baseline.
      w.state.time = 2_000
      w.put(report(), COMPLETE, 1_501)
    }
    return run(argv, init)
  }
  expect((await dispatch(w.io, { role: 'developer', slug: 'fix', task: 'task', cwd: '/wt/fix', effort: 'low' })).text).toContain('delivery: confirmed')
  expect(events).toEqual(['stat', 'prompt', 'identity'])
  expect(w.logs).toEqual([])
  w.state.agents[0]!.agent_status = 'done'
  await w.closer.observe()
  expect(w.calls.filter(call => call[2] === 'close')).toEqual([['herdr', 'pane', 'close', 'w1:p1']])
  expect(w.calls[w.calls.length - 1]).toEqual(['codex', 'archive', UUID])
})

test('identity capture retries a missing Codex session id within five seconds then logs one fixed line', async () => {
  for (const readyAfter of [750, Infinity]) {
    const w = lifecycle(), run = w.io.run
    const pauses: number[] = [], timeouts: number[] = []
    w.io.sleep = async ms => { pauses.push(ms); w.state.time += ms }
    w.io.run = async (argv, init) => {
      if (argv[2] === 'get') timeouts.push(init!.timeoutMs!)
      return run(argv, init)
    }
    w.state.beforeGet = async () => {
      const agent = w.state.agents[0]!
      if (w.state.time < 1_000 + readyAfter) delete agent.agent_session
      else agent.agent_session = { kind: 'id', source: 'herdr:codex', value: UUID }
    }
    expect((await dispatch(w.io, { role: 'developer', slug: 'fix', task: 'task', cwd: '/wt/fix', effort: 'low' })).text).toContain('delivery: confirmed')
    expect(w.calls.filter(call => call[2] === 'prompt')).toHaveLength(1)
    expect(pauses).toEqual(Array(readyAfter === Infinity ? 20 : 3).fill(250))
    expect(timeouts).toHaveLength(readyAfter === Infinity ? 20 : 4)
    expect(timeouts.every(ms => ms > 0 && ms <= 2_000)).toBe(true)
    expect(w.state.time).toBe(1_000 + (readyAfter === Infinity ? 5_000 : readyAfter))
    expect(w.logs).toEqual(readyAfter === Infinity ? ['codex-team: report observation unavailable'] : [])
    w.state.agents[0]!.agent_status = 'done'; w.put(report())
    await w.closer.observe()
    expect(w.calls.filter(call => call[2] === 'close')).toHaveLength(readyAfter === Infinity ? 0 : 1)
    expect(w.timer().timers).toBe(readyAfter === Infinity ? 0 : 1)
  }
})

test('unknown and not_sent deliveries never capture identity or track automatic closure', async () => {
  for (const refusal of ['unknown', 'start', 'prompt']) {
    const status = refusal === 'unknown' ? 'unknown' : 'not_sent'
    const w = lifecycle(), run = w.io.run
    if (refusal === 'start') w.state.startFail = true
    w.io.run = async (argv, init) => argv[2] === 'prompt' ? { exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { code: refusal === 'unknown' ? 'timeout' : 'agent_blocked' } }) } : run(argv, init)
    expect((await dispatch(w.io, { role: 'analyst', task: 'task', slug: 'fix', effort: 'low' })).text).toContain(`delivery: ${status}`)
    expect(w.calls.some(call => call[1] === 'agent' && call[2] === 'get')).toBe(false)
    const calls = w.calls.length
    w.put(report('analyst'))
    await w.closer.observe()
    expect(w.calls).toHaveLength(calls)
    expect(w.timer().timers).toBe(0)
  }
})

test('identity retry budget includes command time and refuses replaced or invalid identities', async () => {
  const slow = lifecycle(), run = slow.io.run
  const timeouts: number[] = []
  slow.io.run = async (argv, init) => {
    if (argv[2] === 'get') { timeouts.push(init!.timeoutMs!); slow.state.time += init!.timeoutMs! }
    return run(argv, init)
  }
  slow.state.beforeGet = async () => { delete slow.state.agents[0]!.agent_session }
  expect((await dispatch(slow.io, { role: 'analyst', slug: 'fix', task: 'task', effort: 'low' })).text).toContain('delivery: confirmed')
  expect(timeouts).toEqual([2_000, 2_000, 500])
  expect(slow.state.time).toBe(6_000)
  expect(slow.logs).toEqual(['codex-team: report observation unavailable'])
  expect(slow.timer().timers).toBe(0)
  for (const fault of ['workspace', 'name', 'pane', 'agent', 'uuid', 'kind', 'source', 'truncated', 'exit', 'json']) {
    const w = lifecycle(), runner = w.io.run
    let gets = 0
    w.state.beforeGet = async () => {
      const live = w.state.agents[0]!
      if (++gets === 1) { delete live.agent_session; return }
      live.agent_session = { kind: 'id', source: 'herdr:codex', value: UUID }
      if (fault === 'workspace') live.workspace_id = 'w2'
      if (fault === 'name') live.name = 'replacement'
      if (fault === 'pane') live.pane_id = 'replacement'
      if (fault === 'agent') live.agent = 'another'
      if (fault === 'uuid') live.agent_session.value = 'invalid'
      if (fault === 'kind') live.agent_session.kind = 'path'
      if (fault === 'source') live.agent_session.source = 'another'
    }
    w.io.run = async (argv, init) => {
      const result = await runner(argv, init)
      if (argv[2] !== 'get' || gets !== 2) return result
      if (fault === 'truncated') return { ...result, isStdoutTruncated: true }
      if (fault === 'exit') return { ...result, exitCode: 1 }
      if (fault === 'json') return { ...result, stdout: 'private invalid JSON' }
      return result
    }
    expect((await dispatch(w.io, { role: 'analyst', slug: 'fix', task: 'task', effort: 'low' })).text).toContain('delivery: confirmed')
    expect(gets).toBe(2)
    expect(w.state.time).toBe(1_250)
    expect(w.timer().timers).toBe(0)
    expect(w.logs).toEqual(['codex-team: report observation unavailable'])
    expect(w.calls.filter(call => call[2] === 'prompt')).toHaveLength(1)
  }
})

test('auto finish requires a confirmed settled agent and a fresh complete role report', async () => {
  for (const role of ['developer', 'analyst', 'architect', 'reviewer'] as const) {
    const w = lifecycle()
    if (role === 'reviewer') w.tasks.set('developer:w1:/repo:fix', { cwd: '/wt/fix', task: 'review original task' })
    expect((await dispatch(w.io, { role, slug: 'fix', task: 'do work', cwd: '/wt/fix', effort: 'low' })).ok).toBe(true)
    w.put(report(role), role === 'reviewer' ? REVIEW : COMPLETE)
    await w.closer.observe()
    expect(w.calls.some(call => call[2] === 'close')).toBe(false)
    w.state.agents[0]!.agent_status = 'done'
    await w.closer.observe()
    expect(w.calls.filter(call => call[2] === 'close')).toHaveLength(1)
    expect(w.calls[w.calls.length - 1]).toEqual(['codex', 'archive', UUID])
    expect(w.timer()).toMatchObject({ timers: 1, cancelled: 1 })
    expect(JSON.parse(w.writes[w.writes.length - 1]!.text)).toMatchObject({ v: 2, action: 'finish', trigger: 'report', closed: true, archived: true })
  }
  for (const fault of ['identity', 'stat', 'timer']) {
    const w = lifecycle()
    if (fault === 'identity') w.state.beforeGet = async () => { throw new Error('private') }
    if (fault === 'stat') w.io.reports!.stat = async () => { throw new Error('private') }
    if (fault === 'timer') w.io.autoCloser = createAutoCloser({ ...w.io.reports!, run: w.io.run, log: w.io.log, timer: () => { throw new Error('private') }, finish: async () => undefined })
    expect((await dispatch(w.io, { role: 'analyst', slug: 'fix', task: 'task', effort: 'low' })).text).toContain('delivery: confirmed')
    expect(w.calls.filter(call => call[2] === 'prompt')).toHaveLength(1)
    expect(w.logs).toEqual(['codex-team: report observation unavailable'])
  }
})

test('auto finish preserves blocked unknown stale symlink missing and incomplete reports', async () => {
  for (const fault of ['blocked', 'unknown', 'working', 'old', 'future-baseline', 'symlink', 'missing', 'incomplete', 'blocked-report', 'changed-read', 'read-failure', 'foreign', 'uuid', 'lead', 'unknown-delivery', 'timestamp', 'stat-failure']) {
    const w = lifecycle()
    const live = { name: entry().effectiveAgent, workspace_id: 'w1', pane_id: 'w1:p1', agent_status: 'idle', agent: 'codex', agent_session: { kind: 'id', source: 'herdr:codex', value: UUID } }
    w.state.agents.push(live)
    w.put(report())
    const tracked = entry()
    if (['blocked', 'unknown', 'working'].includes(fault)) live.agent_status = fault
    if (fault === 'old') w.files.get(report())!.stat.mtimeMs = 1_000
    if (fault === 'future-baseline') tracked.baselineMtime = 9_999
    if (fault === 'timestamp') tracked.submittedAt = NaN
    if (fault === 'stat-failure') w.io.reports!.stat = async () => { throw new Error('private stat details') }
    if (fault === 'symlink') w.files.get(report())!.stat.isLink = true
    if (fault === 'missing') w.files.clear()
    if (fault === 'incomplete') w.put(report(), 'status: done')
    if (fault === 'blocked-report') w.put(report(), COMPLETE.replace('partial', 'blocked'))
    if (fault === 'changed-read') w.state.beforeRead = async () => { w.files.get(report())!.stat.mtimeMs++ }
    if (fault === 'read-failure') w.state.beforeRead = async () => { throw new Error('private details') }
    if (fault === 'foreign') live.workspace_id = 'w2'
    if (fault === 'uuid') live.agent_session.value = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    if (fault === 'lead') { live.pane_id = tracked.pane = 'lead' }
    if (fault !== 'unknown-delivery') w.closer.track(tracked)
    await w.closer.observe()
    expect(w.calls.some(call => call[2] === 'close' || call[0] === 'codex')).toBe(false)
  }
  const w = lifecycle()
  const run = w.io.run
  w.io.run = async (argv, init) => argv[2] === 'prompt' ? { exitCode: 1, stdout: '', stderr: '{"error":{"code":"timeout"}}' } : run(argv, init)
  expect((await dispatch(w.io, { role: 'analyst', task: 'task', slug: 'fix', effort: 'low' })).text).toContain('delivery: unknown')
  w.state.agents[0]!.agent_status = 'done'; w.put(report('analyst'))
  await w.closer.observe()
  expect(w.timer().timers).toBe(0)
})

test('overlapping ticks and queued candidates cannot finish a replaced watcher', async () => {
  const w = lifecycle()
  await dispatch(w.io, { role: 'developer', slug: 'fix', task: 'task', cwd: '/wt/fix', effort: 'low' })
  w.put(report()); w.state.agents[0]!.agent_status = 'done'
  let release!: () => void
  w.state.beforeRead = () => new Promise<void>(resolve => { release = resolve })
  const observing = w.closer.observe()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const listings = w.calls.filter(call => call[2] === 'list').length
  await w.closer.observe()
  expect(w.calls.filter(call => call[2] === 'list').length).toBe(listings)
  const newer = entry({ submittedAt: 9_000 })
  w.closer.track(newer)
  w.state.beforeRead = undefined; release()
  await observing
  expect(w.closer.current(newer)).toBe(true)
  expect(w.calls.some(call => call[2] === 'close')).toBe(false)
  const pending = w.closer.observe()
  w.closer.stop()
  await pending
  expect(w.closer.current(newer)).toBe(false)

  const queued = lifecycle()
  await dispatch(queued.io, { role: 'developer', slug: 'fix', task: 'task', cwd: '/wt/fix', effort: 'low' })
  queued.state.agents[0]!.agent_status = 'done'; queued.put(report())
  const runner = queued.io.run
  let unblock!: () => void
  queued.io.run = async (argv, init) => { if (argv[0] === 'mkdir') await new Promise<void>(resolve => { unblock = resolve }); return runner(argv, init) }
  const dispatching = dispatch(queued.io, { role: 'analyst', slug: 'other', task: 'task', effort: 'low' })
  for (let i = 0; i < 30 && !unblock; i++) await Promise.resolve()
  const finishing = queued.closer.observe()
  for (let i = 0; i < 30; i++) await Promise.resolve()
  const replacement = entry({ submittedAt: 9_000 })
  queued.closer.track(replacement)
  unblock(); await dispatching; await finishing
  expect(queued.closer.current(replacement)).toBe(true)
  expect(queued.calls.some(call => call[2] === 'close')).toBe(false)
})

test('an entry tracked while a listing is pending is kept and closes on a later tick', async () => {
  const w = lifecycle()
  await dispatch(w.io, { role: 'developer', slug: 'fix', task: 'task', cwd: '/wt/fix', effort: 'low' })
  w.closer.stop()
  let release!: () => void, started!: () => void
  const listingPending = new Promise<void>(resolve => { started = resolve })
  const listingReleased = new Promise<void>(resolve => { release = resolve })
  let defer = true
  const closer = w.io.autoCloser = createAutoCloser({ ...w.io.reports!, log: w.io.log, timer: () => () => {},
    run: async (argv, init) => {
      const result = await w.io.run(argv, init)
      if (defer && argv[1] === 'agent' && argv[2] === 'list') {
        defer = false; started(); await listingReleased
      }
      return result
    },
    finish: (tracked, current) => autoFinish(w.io, tracked, current),
  })
  closer.track(entry())
  const observing = closer.observe()
  await listingPending
  const newer = entry({ uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
  closer.track(newer)
  w.state.agents[0]!.agent_session!.value = newer.uuid
  w.state.agents[0]!.agent_status = 'done'
  w.put(report())
  release(); await observing
  expect(closer.current(newer)).toBe(true)
  expect(w.calls.some(call => call[2] === 'close')).toBe(false)
  await closer.observe()
  expect(w.calls.filter(call => call[2] === 'close')).toEqual([['herdr', 'pane', 'close', 'w1:p1']])
  expect(w.calls[w.calls.length - 1]).toEqual(['codex', 'archive', newer.uuid])
})

test('auto finish preserves developer context and records archive failure once', async () => {
  const w = lifecycle()
  await dispatch(w.io, { role: 'developer', task: 'private original', slug: 'fix', cwd: '/wt/fix', effort: 'low' })
  const context = w.tasks.get('developer:w1:/repo:fix')
  w.put(report()); w.state.agents[0]!.agent_status = 'idle'; w.state.archiveExit = 7
  await w.closer.observe(); await w.closer.observe()
  expect(w.tasks.get('developer:w1:/repo:fix')).toEqual(context)
  expect(w.files.has(report())).toBe(true)
  expect(w.calls.filter(call => call[0] === 'codex')).toHaveLength(1)
  expect(w.logs).toEqual(['codex-team: report finish archive pending'])
  expect(JSON.stringify(w.writes)).not.toContain('private original')
  expect(await readyReport(w.io.reports!, 'developer', report(), 1_000)).toBe(true)
})
