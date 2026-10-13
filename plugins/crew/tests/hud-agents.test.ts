import { expect, test } from 'claude-code/testing'
import { createAgentTracker } from '../hooks/hud/agents'
import type { AgentIo } from '../hooks/hud/agents'
import type { CrewAgent } from '../types'

const tick = () => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(resolve, 0))
const settle = async () => { for (let i = 0; i < 10; i++) await tick() }

/** The displayed records, a clock the test moves and the host's agent list; writes can be held or made to fail. */
function world() {
  const w = {
    records: [] as CrewAgent[],
    time: 1_000,
    listed: [] as { id: string; type: string; status: string }[],
    logs: [] as string[],
    failWrites: false,
    hold: undefined as Promise<void> | undefined,
    writes: 0,
  }
  const io: AgentIo = {
    now: async () => w.time,
    list: async () => w.listed,
    update: async change => {
      w.writes++
      if (w.hold) await w.hold
      if (w.failWrites) throw new Error('write failed')
      w.records = change(w.records)
    },
    log: text => { w.logs.push(text) },
  }
  return { w, io }
}
const only = (w: ReturnType<typeof world>['w'], id: string) => w.records.find(record => record.id === id)

test('a spawn records a running agent with its type, model and start; a step keeps its start and updates its effort', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  expect(only(w, 'a1')).toEqual({ id: 'a1', type: 'crew:developer', model: 'sonnet', startedAt: 1_000, seenAt: undefined,
    status: 'running', effort: undefined, observedModel: undefined })
  w.time = 5_000
  tracker.stepped(io, 'a1', { model: 'sonnet', effort: 'high' }, undefined)
  await settle()
  expect(only(w, 'a1')).toMatchObject({ model: 'sonnet', startedAt: 1_000, effort: 'high', status: 'running' })
})

test('a spawn of a type outside crew is not recorded, and neither is a step of an agent whose type is unknown', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  tracker.spawning(io)({ id: 'a1', type: 'general-purpose', model: 'sonnet' })
  tracker.stepped(io, 'a1', { model: 'sonnet' }, undefined)
  tracker.stepped(io, undefined, { model: 'sonnet' }, undefined)
  await settle()
  expect(w.records).toEqual([])
})

test('the requested effort is the login effort, then the model suffix, then the host effort as a string', async () => {
  const cases: [{ model: string; effort?: unknown }, string | undefined, string | undefined][] = [
    [{ model: 'cx/gpt-6-sol-high', effort: 'low' }, 'medium', 'medium'],
    [{ model: 'cx/gpt-6-sol-high', effort: 'low' }, undefined, 'high'],
    [{ model: 'gpt-6-sol-low' }, undefined, 'low'],
    [{ model: 'sonnet', effort: 'low' }, undefined, 'low'],
    [{ model: 'sonnet', effort: 3 }, undefined, undefined],
  ]
  for (const [sent, login, effort] of cases) {
    const { w, io } = world()
    const tracker = createAgentTracker()
    tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
    await settle()
    tracker.stepped(io, 'a1', sent, login)
    await settle()
    expect(only(w, 'a1')?.effort).toBe(effort)
  }
})

test('a first step and its answer before the spawn resolves are retained by the spawn', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  const spawned = tracker.spawning(io)
  const noted = tracker.stepped(io, 'a1', { model: 'cx/gpt-6-sol-high' }, undefined)
  tracker.answered(io, 'a1', noted, { usage: { model: 'gpt-6-sol' } })
  await settle()
  // Nothing is shown for a type nobody has named yet.
  expect(w.records).toEqual([])
  spawned({ id: 'a1', type: 'crew:developer-codex', model: 'cx/gpt-6-sol-medium' })
  await settle()
  expect(only(w, 'a1')).toMatchObject({ type: 'crew:developer-codex', model: 'cx/gpt-6-sol-high', effort: 'high', observedModel: 'gpt-6-sol' })
})

test('an answer records the model it reports on the running job, and a null usage records nothing', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  const noted = tracker.stepped(io, 'a1', { model: 'sonnet' }, undefined)
  tracker.answered(io, 'a1', noted, { usage: null })
  tracker.answered(io, 'a1', undefined, { usage: { model: 'x' } })
  tracker.answered(io, undefined, noted, { usage: { model: 'x' } })
  await settle()
  expect(only(w, 'a1')?.observedModel).toBeUndefined()
  tracker.answered(io, 'a1', noted, { usage: { model: 'claude-sonnet' } })
  await settle()
  expect(only(w, 'a1')?.observedModel).toBe('claude-sonnet')
})

test('completion ends the agent; a late spawn cannot reopen it and a new step restarts it with its own start and model', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  const spawned = tracker.spawning(io)
  tracker.stepped(io, 'a1', { model: 'sonnet' }, undefined)
  tracker.completed(io, 'a1')
  spawned({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  expect(w.records).toEqual([])
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  expect(w.records).toEqual([])
  // A reconcile shows it, a completion ends it, and the next step starts a new job.
  w.listed = [{ id: 'a2', type: 'crew:developer', status: 'running' }]
  await tracker.reconcile(io)
  w.time = 2_000
  tracker.completed(io, 'a2')
  await settle()
  expect(only(w, 'a2')?.status).toBe('ended')
  w.time = 9_000
  tracker.stepped(io, 'a2', { model: 'opus', effort: 'low' }, undefined)
  await settle()
  expect(only(w, 'a2')).toEqual({ id: 'a2', type: 'crew:developer', model: 'opus', status: 'running', startedAt: 9_000, effort: 'low' })
})

test('an answer arriving after completion, or from a job that a newer step replaced, is dropped', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  const first = tracker.stepped(io, 'a1', { model: 'sonnet' }, undefined)
  const second = tracker.stepped(io, 'a1', { model: 'sonnet' }, undefined)
  tracker.answered(io, 'a1', first, { usage: { model: 'stale' } })
  await settle()
  expect(only(w, 'a1')?.observedModel).toBeUndefined()
  tracker.completed(io, 'a1')
  tracker.answered(io, 'a1', second, { usage: { model: 'late' } })
  await settle()
  expect(only(w, 'a1')).toMatchObject({ status: 'ended', observedModel: undefined })
})

test('a spawn that was waiting while a newer job of the same ID began cannot replace it', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  tracker.completed(io, 'a1')
  await settle()
  const stale = tracker.spawning(io)
  w.time = 7_000
  tracker.stepped(io, 'a1', { model: 'opus' }, undefined)
  await settle()
  expect(only(w, 'a1')).toMatchObject({ model: 'opus', startedAt: 7_000, status: 'running' })
  stale({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  expect(only(w, 'a1')).toMatchObject({ model: 'opus', startedAt: 7_000, status: 'running' })
})

test('reconcile shows a listed running or pending crew agent as seen, ends one the host reports over, and skips other types', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  w.listed = [
    { id: 'r', type: 'crew:developer', status: 'running' },
    { id: 'p', type: 'crew:architect', status: 'pending' },
    { id: 'x', type: 'general-purpose', status: 'running' },
    { id: 'd', type: 'crew:designer', status: 'completed' },
  ]
  await tracker.reconcile(io)
  expect(w.records.map(r => [r.id, r.status, r.seenAt])).toEqual([['r', 'running', 1_000], ['p', 'running', 1_000]])
  for (const status of ['completed', 'failed', 'killed', 'idle']) {
    w.listed = [{ id: 'r', type: 'crew:developer', status }]
    await tracker.reconcile(io)
    expect(only(w, 'r')?.status).toBe('ended')
    w.records = w.records.map(r => ({ ...r, status: 'running' as const }))
  }
  // Once the host reported it over, a record that is dropped is not made again.
  w.records = []
  w.listed = [{ id: 'r', type: 'crew:developer', status: 'running' }]
  await tracker.reconcile(io)
  expect(w.records).toEqual([])
})

test('a seen agent that steps keeps its seen mark and gets no invented start; a step of a persisted ended agent restarts it', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  w.listed = [{ id: 'a1', type: 'crew:developer', status: 'running' }]
  await tracker.reconcile(io)
  w.time = 4_000
  tracker.stepped(io, 'a1', { model: 'sonnet', effort: 'high' }, undefined)
  await settle()
  expect(only(w, 'a1')).toEqual({ id: 'a1', type: 'crew:developer', model: 'sonnet', status: 'running', seenAt: 1_000, effort: 'high', observedModel: undefined })
  // After a reload the record is ended and persisted, and the tracker has never heard of the ID.
  const fresh = createAgentTracker()
  w.records = [{ id: 'a1', type: 'crew:developer', model: 'old', observedModel: 'old-seen', effort: 'low', startedAt: 10, status: 'ended' }]
  w.time = 6_000
  fresh.stepped(io, 'a1', { model: 'new' }, undefined)
  await settle()
  expect(only(w, 'a1')).toEqual({ id: 'a1', type: 'crew:developer', model: 'new', status: 'running', startedAt: 6_000 })
})

test('queued observations of one ID are bounded to one per kind and run spawn, step, answer in that order', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  let release: () => void = () => {}
  w.hold = new Promise<void>(resolve => { release = resolve })
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  const writes = w.writes
  expect(writes).toBe(1)
  // Many steps and answers behind the held write coalesce to the newest of each kind.
  let noted
  for (let i = 0; i < 20; i++) {
    noted = tracker.stepped(io, 'a1', { model: `m${i}` }, undefined)
    tracker.answered(io, 'a1', noted, { usage: { model: `seen${i}` } })
  }
  await settle()
  expect(w.writes).toBe(writes)
  w.hold = undefined
  release()
  await settle()
  expect(w.writes - writes).toBe(2)
  expect(only(w, 'a1')).toMatchObject({ status: 'running', observedModel: 'seen19' })
})

test('completion drops the queued observations of the agent', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  let release: () => void = () => {}
  w.hold = new Promise<void>(resolve => { release = resolve })
  tracker.stepped(io, 'a1', { model: 'sonnet' }, undefined)
  await settle()
  tracker.stepped(io, 'a1', { model: 'later' }, undefined)
  tracker.completed(io, 'a1')
  w.hold = undefined
  release()
  await settle()
  expect(only(w, 'a1')).toMatchObject({ status: 'ended', model: 'sonnet' })
  // The held step and the completion wrote; the replaced pending step never did.
  expect(w.writes).toBe(3)
})

test('a reset drops what an earlier lifecycle queued, and each lifecycle number is new', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  const lifecycle = tracker.lifecycle()
  let release: () => void = () => {}
  w.hold = new Promise<void>(resolve => { release = resolve })
  w.listed = [{ id: 'a1', type: 'crew:developer', status: 'running' }]
  tracker.spawning(io)({ id: 'a2', type: 'crew:developer', model: 'sonnet' })
  await settle()
  tracker.reset()
  expect(tracker.lifecycle()).toBe(lifecycle + 1)
  w.hold = undefined
  release()
  await settle()
  expect(w.records).toEqual([])
  // The reset also forgot every ID, so a step for one without a type shows nothing.
  tracker.stepped(io, 'a2', { model: 'sonnet' }, undefined)
  await settle()
  expect(w.records).toEqual([])
})

test('a write that fails is logged and never reaches the caller; a log that fails is swallowed too', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  w.failWrites = true
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  tracker.completed(io, 'a1')
  await settle()
  expect(w.logs.length).toBeGreaterThan(0)
  expect(new Set(w.logs)).toEqual(new Set(['crew HUD: observation failed']))
  io.log = () => { throw new Error('log failed') }
  tracker.spawning(io)({ id: 'b1', type: 'crew:developer', model: 'sonnet' })
  tracker.stepped(io, 'b1', { model: 'sonnet' }, undefined)
  await settle()
})

test('a step or answer that cannot be noted returns nothing, logs and never throws', () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  const hostile = { get model(): string { throw new Error('hostile') } }
  expect(tracker.stepped(io, 'a1', hostile, undefined)).toBeUndefined()
  const answer = { get usage(): { model: string } { throw new Error('hostile') } }
  expect(() => tracker.answered(io, 'a1', { generation: 1, token: 1 }, answer)).not.toThrow()
  expect(w.logs).toEqual(['crew HUD: observation failed', 'crew HUD: observation failed'])
  io.log = () => { throw new Error('log failed') }
  expect(tracker.stepped(io, 'a1', hostile, undefined)).toBeUndefined()
  expect(() => tracker.answered(io, 'a1', { generation: 1, token: 1 }, answer)).not.toThrow()
})

test('the step of an ID whose first job ended starts a new generation, so an older answer token no longer matches', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  const first = tracker.stepped(io, 'a1', { model: 'sonnet' }, undefined)
  tracker.completed(io, 'a1')
  const second = tracker.stepped(io, 'a1', { model: 'sonnet' }, undefined)
  expect(first).toEqual({ generation: 1, token: 1 })
  expect(second).toEqual({ generation: 2, token: 2 })
  tracker.answered(io, 'a1', first, { usage: { model: 'old' } })
  await settle()
  expect(only(w, 'a1')?.observedModel).toBeUndefined()
})

test('a stale answer before the spawn resolves leaves no observed model for the spawn to take', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  const spawned = tracker.spawning(io)
  const first = tracker.stepped(io, 'a1', { model: 'sonnet' }, undefined)
  tracker.stepped(io, 'a1', { model: 'sonnet' }, undefined)
  tracker.answered(io, 'a1', first, { usage: { model: 'stale' } })
  await settle()
  spawned({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  expect(only(w, 'a1')).toMatchObject({ status: 'running', observedModel: undefined })
})

test('a reset forgets which agents ended, so a spawn of the same ID in the next session is shown', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  tracker.completed(io, 'a1')
  tracker.reset()
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  expect(only(w, 'a1')).toMatchObject({ status: 'running' })
})

test('a step of an agent whose type is known keeps no early observation for a later spawn of the same ID', async () => {
  const { w, io } = world()
  const tracker = createAgentTracker()
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'sonnet' })
  await settle()
  tracker.stepped(io, 'a1', { model: 'opus' }, undefined)
  await settle()
  tracker.spawning(io)({ id: 'a1', type: 'crew:developer', model: 'fresh' })
  await settle()
  expect(only(w, 'a1')?.model).toBe('sonnet')
})
