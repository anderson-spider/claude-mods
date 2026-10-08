import { expect, test } from 'claude-code/testing'
import { ago, buildRoster, ROLE_ORDER } from '../hooks/roster'
import type { Job, Native, PantheonConfig, SessionInfo } from '../hooks/types'

const config = (overrides: Partial<PantheonConfig> = {}): PantheonConfig => ({
  sandboxCap: 'workspace-write', noNetwork: false, foregroundMinutes: 5, disabledAgents: [],
  agents: {
    explorer: { model: 'explorer-model' }, librarian: {}, fixer: { model: 'fixer-model' },
    oracle: { model: 'oracle-model' }, designer: {},
  },
  council: { seats: {
    alpha: { engine: 'codex', model: 'alpha-model' },
    beta: { engine: 'claude', model: 'beta-model' },
  } },
  ...overrides,
})
const job = (overrides: Partial<Job> = {}): Job => ({
  id: 'job', agent: 'explorer', status: 'running', startedAt: 100, cwd: '/repo', ...overrides,
})
const native = (overrides: Partial<Native> = {}): Native => ({
  id: 'native', role: 'oracle', type: 'pantheon:oracle', task: 'Review', model: 'native-model',
  rounds: [{ startedAt: 100, status: 'running' }], ctx: 40, out: 10, steps: 2, ...overrides,
})
const roster = (jobs: Job[] = [], natives: Native[] = [], c = config(), session: SessionInfo = { isRunning: false }) =>
  buildRoster({ jobs, natives, config: c, session })

test('seven slots in fixed order with nothing running', () => {
  const result = roster()
  expect(result.slots.map(s => s.name)).toEqual(ROLE_ORDER)
  expect(result.slots.map(s => s.state)).toEqual(['idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'idle'])
  expect(result.others).toEqual([])
  expect(result.counts).toEqual({ active: 0, idle: 7, off: 0 })
})

test('active, idle with last ended, and off', () => {
  const result = roster([job()], [native({ rounds: [{ startedAt: 100, endedAt: 200, status: 'done' }] })],
    config({ disabledAgents: ['librarian'] }))
  expect(result.slots[1].state).toBe('active')
  expect(result.slots[4]).toEqual(expect.objectContaining({ state: 'idle', lastEndedAt: 200 }))
  expect(result.slots[2]).toEqual(expect.objectContaining({ state: 'off', offReason: 'disabledAgents' }))
  expect(result.counts).toEqual({ active: 1, idle: 5, off: 1 })
})

test('parallel instances stack', () => {
  const result = roster([
    job({ id: 'one', agent: 'fixer', sessionId: 'first' }),
    job({ id: 'two', agent: 'fixer', sessionId: 'second' }),
  ])
  expect(result.slots[3].instances.map(i => i.id)).toEqual(['one', 'two'])
  expect(result.slots[3].state).toBe('active')
  expect(result.counts.active).toBe(1)
})

test('jobs sharing a sessionId are one line with N rounds', () => {
  const jobs = [
    job({ id: 'third', sessionId: 'shared', startedAt: 300, endedAt: 350, status: 'error',
      description: 'Latest task', model: 'latest-model', lastActivity: 'Latest activity',
      tokens: { input: 70, cached: 20, output: 15 } }),
    job({ id: 'first', sessionId: 'shared', startedAt: 100, endedAt: 150, status: 'done' }),
    job({ id: 'second', sessionId: 'shared', startedAt: 200, endedAt: 250, status: 'done' }),
  ]
  const snapshot = JSON.stringify(jobs)
  const instance = roster(jobs).slots[1].instances[0]
  expect(instance).toEqual(expect.objectContaining({
    id: 'first', status: 'error', isActive: false, startedAt: 300, endedAt: 350,
    task: 'Latest task', model: 'latest-model', activity: 'Latest activity', resumeId: 'third',
    tokens: { input: 70, cached: 20, out: 15 },
  }))
  expect(instance.rounds).toEqual([
    { startedAt: 100, endedAt: 150, status: 'done' },
    { startedAt: 200, endedAt: 250, status: 'done' },
    { startedAt: 300, endedAt: 350, status: 'error' },
  ])
  expect(JSON.stringify(jobs)).toBe(snapshot)
})

test('council is one slot', () => {
  const jobs = [job({ agent: 'councillor:alpha' })]
  const natives = [native({ role: 'councillor-beta' })]
  const council = roster(jobs, natives, config({ disabledAgents: ['councillor:beta'] })).slots[6]
  expect(council).toEqual(expect.objectContaining({ state: 'active', engine: 'mixed', seatsOff: ['beta'] }))
  expect(council.instances.map(i => [i.engine, i.seat])).toEqual([['codex', 'alpha'], ['claude', 'beta']])
  expect(roster(jobs, natives, config({ disabledAgents: ['council'] })).slots[6])
    .toEqual(expect.objectContaining({ state: 'off', offReason: 'disabledAgents' }))
})

test('council is off when every seat is disabled with either spelling', () => {
  expect(roster([], [], config({ disabledAgents: ['councillor:alpha', 'councillor-beta'] })).slots[6].state).toBe('off')
  expect(roster([], [], config({ council: { seats: {} } })).slots[6].state).toBe('off')
})

test('delegating lists active roles in order', () => {
  const result = roster([job({ agent: 'fixer' }), job({ id: 'explorer', status: 'background' }),
    job({ id: 'seat', agent: 'councillor:alpha' })], [native({ role: 'designer' })],
    config(), { isRunning: true, model: 'session-model' })
  expect(result.delegating).toEqual(['explorer', 'fixer', 'designer', 'council'])
  expect(result.slots[0]).toEqual(expect.objectContaining({ state: 'active', model: 'session-model', engine: 'claude' }))
})

test('orchestrator is never off and native disabling uses role offers', () => {
  const result = roster([], [], config({ disabledAgents: ['orchestrator', 'oracle', 'designer'] }),
    { isRunning: false, model: 'session-model' })
  expect(result.slots[0]).toEqual(expect.objectContaining({ state: 'idle', model: 'session-model' }))
  expect(result.slots[4].state).toBe('off')
  expect(result.slots[5].state).toBe('off')
})

test('other agents only when present', () => {
  const result = roster([], [native({ role: 'other', lastTool: 'Read', rounds: [
    { startedAt: 100, endedAt: 200, status: 'done' }, { startedAt: 300, status: 'running' },
  ] })])
  expect(result.others).toHaveLength(1)
  expect(result.others[0]).toEqual(expect.objectContaining({
    engine: 'claude', isActive: true, startedAt: 300, activity: 'Read',
    tokens: { ctx: 40, out: 10, steps: 2 },
  }))
  expect(result.others[0].rounds).toHaveLength(2)
  expect(result.counts.active).toBe(0)
})

test('active instances precede only the latest ended one', () => {
  const result = roster([
    job({ id: 'old', status: 'done', endedAt: 150 }),
    job({ id: 'latest', status: 'done', startedAt: 80, endedAt: 400 }),
    job({ id: 'active', status: 'background', startedAt: 300, sessionId: 'live', model: 'running-model' }),
    job({ id: 'middle', status: 'cancelled', startedAt: 200, endedAt: 250 }),
  ])
  expect(result.slots[1].instances.map(i => i.id)).toEqual(['active', 'latest'])
  expect(result.slots[1].lastEndedAt).toBe(400)
  expect(result.slots[1].model).toBe('running-model')
  expect(result.slots[1].instances[0].resumeId).toBeUndefined()
})

test('jobs without session ids stay separate and missing tokens default to zero output', () => {
  const instances = roster([job({ id: 'one' }), job({ id: 'two' })]).slots[1].instances
  expect(instances).toHaveLength(2)
  expect(instances[0].tokens).toEqual({ out: 0 })
  expect(instances[0].resumeId).toBeUndefined()
})

test('idle rows use configured models instead of the last instance model', () => {
  const result = roster([job({ status: 'done', endedAt: 200, model: 'old-model' })],
    [native({ rounds: [{ startedAt: 100, endedAt: 200, status: 'stopped' }] })],
    config({ council: { seats: { alpha: { engine: 'codex', model: 'seat-model' } } } }))
  expect(result.slots[1].model).toBe('explorer-model')
  expect(result.slots[4].model).toBe('oracle-model')
  expect(result.slots[4].instances[0].isActive).toBe(false)
  expect(result.slots[6]).toEqual(expect.objectContaining({ engine: 'codex', model: 'seat-model' }))
})

test('ago formats', () => {
  expect(ago(12_000)).toBe('12s')
  expect(ago(720_000)).toBe('12m')
  expect(ago(3 * 3_600_000)).toBe('3h')
  expect(ago(59_999)).toBe('59s')
  expect(ago(60_000)).toBe('1m')
  expect(ago(3_600_000)).toBe('1h')
  expect(ago(0)).toBe('0s')
})
