import { expect, test } from 'claude-code/testing'
import { ago, buildRoster, ROLE_ORDER } from '../hooks/roster'
import { DEFAULTS } from './fixtures/config'
import type { Native, PantheonConfig, SessionInfo } from '../hooks/types'

const config = (overrides: Partial<PantheonConfig> = {}): PantheonConfig => ({
  disabledAgents: [],
  agents: {
    'code-reader': { model: 'code-reader-model' }, 'docs-reader': {}, developer: { model: 'developer-model' },
    architect: { model: 'architect-model' }, ux: {}, git: {},
  },
  council: { seats: {
    alpha: { model: 'alpha-model' },
    beta: { model: 'beta-model' },
  } },
  ...overrides,
})
const native = (overrides: Partial<Native> = {}): Native => ({
  id: 'native', role: 'architect', type: 'pantheon:architect', task: 'Review', model: 'native-model',
  rounds: [{ startedAt: 100, status: 'running' }], ctx: 40, out: 10, steps: 2, ...overrides,
})
const roster = (natives: Native[] = [], c = config(), session: SessionInfo = { isRunning: false }) =>
  buildRoster({ natives, config: c, session })

test('eight slots in fixed order with nothing running', () => {
  const result = roster()
  expect(ROLE_ORDER).toEqual(['lead', 'code-reader', 'docs-reader', 'developer', 'architect', 'ux', 'git', 'council'])
  expect(result.slots.map(s => s.name)).toEqual(ROLE_ORDER)
  expect(result.slots.map(s => s.state)).toEqual(Array(8).fill('idle'))
  expect(result.others).toEqual([])
  expect(result.counts).toEqual({ active: 0, idle: 8, off: 0 })
})

test('active, idle with last ended, and off', () => {
  const result = roster([
    native({ id: 'run', role: 'code-reader', type: 'pantheon:code-reader' }),
    native({ rounds: [{ startedAt: 100, endedAt: 200, status: 'done' }] }),
  ], config({ disabledAgents: ['docs-reader'] }))
  expect(result.slots[1].state).toBe('active')
  expect(result.slots[4]).toEqual(expect.objectContaining({ state: 'idle', lastEndedAt: 200 }))
  expect(result.slots[2]).toEqual(expect.objectContaining({ state: 'off', offReason: 'disabledAgents' }))
  expect(result.counts).toEqual({ active: 1, idle: 6, off: 1 })
})

test('parallel instances stack', () => {
  const result = roster([
    native({ id: 'one', role: 'developer', type: 'pantheon:developer' }),
    native({ id: 'two', role: 'developer', type: 'pantheon:developer' }),
  ])
  expect(result.slots[3].instances.map(i => i.id)).toEqual(['one', 'two'])
  expect(result.slots[3].state).toBe('active')
  expect(result.counts.active).toBe(1)
})

test('a native with several rounds is one line showing its latest round', () => {
  const natives = [native({
    id: 'multi', role: 'code-reader', type: 'pantheon:code-reader', task: 'Latest task', model: 'latest-model',
    lastTool: 'Read', rounds: [
      { startedAt: 100, endedAt: 150, status: 'done' },
      { startedAt: 200, endedAt: 250, status: 'done' },
      { startedAt: 300, endedAt: 350, status: 'failed' },
    ],
  })]
  const snapshot = JSON.stringify(natives)
  const instances = roster(natives).slots[1].instances
  expect(instances).toHaveLength(1)
  expect(instances[0]).toEqual(expect.objectContaining({
    id: 'multi', status: 'failed', isActive: false, startedAt: 300, endedAt: 350,
    task: 'Latest task', model: 'latest-model', activity: 'Read', tokens: { ctx: 40, out: 10, steps: 2 },
  }))
  expect(instances[0].rounds).toEqual([
    { startedAt: 100, endedAt: 150, status: 'done' },
    { startedAt: 200, endedAt: 250, status: 'done' },
    { startedAt: 300, endedAt: 350, status: 'failed' },
  ])
  expect(JSON.stringify(natives)).toBe(snapshot)
})

test('the council slot lists every configured seat', () => {
  expect(roster([], config()).slots[7].seats).toEqual(['alpha', 'beta'])
})

test('council is one slot', () => {
  const natives = [native({ id: 'a', role: 'councillor-alpha', type: 'pantheon:councillor-alpha' }), native({ id: 'b', role: 'councillor-beta' })]
  const council = roster(natives, config({ disabledAgents: ['councillor:beta'] })).slots[7]
  expect(council).toEqual(expect.objectContaining({ state: 'active', seatsOff: ['beta'] }))
  expect(council.instances.map(i => i.seat)).toEqual(['alpha', 'beta'])
  expect(roster(natives, config({ disabledAgents: ['council'] })).slots[7])
    .toEqual(expect.objectContaining({ state: 'off', offReason: 'disabledAgents' }))
})

test('council is off when every seat is disabled with either spelling', () => {
  expect(roster([], config({ disabledAgents: ['councillor:alpha', 'councillor-beta'] })).slots[7].state).toBe('off')
  expect(roster([], config({ council: { seats: {} } })).slots[7].state).toBe('off')
})

test('delegating lists active roles in order', () => {
  const result = roster([
    native({ id: 'e', role: 'developer' }), native({ id: 'x', role: 'code-reader' }),
    native({ id: 'seat', role: 'councillor-alpha' }), native({ id: 'd', role: 'ux' }),
  ], config(), { isRunning: true, model: 'session-model' })
  expect(result.delegating).toEqual(['code-reader', 'developer', 'ux', 'council'])
  expect(result.slots[0]).toEqual(expect.objectContaining({ state: 'active', model: 'session-model' }))
})

test('lead is never off and roles use disabledAgents', () => {
  const result = roster([], config({ disabledAgents: ['lead', 'architect', 'ux'] }),
    { isRunning: false, model: 'session-model' })
  expect(result.slots[0]).toEqual(expect.objectContaining({ state: 'idle', model: 'session-model' }))
  expect(result.slots[4].state).toBe('off')
  expect(result.slots[5].state).toBe('off')
})

test('other agents only when present', () => {
  const result = roster([native({ role: 'other', lastTool: 'Read', rounds: [
    { startedAt: 100, endedAt: 200, status: 'done' }, { startedAt: 300, status: 'running' },
  ] })])
  expect(result.others).toHaveLength(1)
  expect(result.others[0]).toEqual(expect.objectContaining({
    isActive: true, startedAt: 300, activity: 'Read',
    tokens: { ctx: 40, out: 10, steps: 2 },
  }))
  expect(result.others[0].rounds).toHaveLength(2)
  expect(result.counts.active).toBe(0)
})

test('active instances precede every ended instance, newest end first', () => {
  const ex = (o: Partial<Native>) => native({ role: 'code-reader', type: 'pantheon:code-reader', ...o })
  const result = roster([
    ex({ id: 'old', rounds: [{ startedAt: 50, endedAt: 150, status: 'done' }] }),
    ex({ id: 'latest', rounds: [{ startedAt: 80, endedAt: 400, status: 'done' }] }),
    ex({ id: 'active', model: 'running-model', rounds: [{ startedAt: 300, status: 'running' }] }),
    ex({ id: 'middle', rounds: [{ startedAt: 200, endedAt: 250, status: 'stopped' }] }),
  ])
  expect(result.slots[1].instances.map(i => i.id)).toEqual(['active', 'latest', 'middle', 'old'])
  expect(result.slots[1].lastEndedAt).toBe(400)
  expect(result.slots[1].model).toBe('running-model')
})

test('history keeps every line of a role, oldest first, for the timeline', () => {
  const ex = (o: Partial<Native>) => native({ role: 'code-reader', type: 'pantheon:code-reader', ...o })
  const result = roster([
    ex({ id: 'late', rounds: [{ startedAt: 300, endedAt: 400, status: 'done' }] }),
    ex({ id: 'early', rounds: [{ startedAt: 100, endedAt: 200, status: 'done' }] }),
  ])
  expect(result.slots[1].instances.map(i => i.id)).toEqual(['late', 'early'])
  expect(result.slots[1].history?.map(i => i.id)).toEqual(['early', 'late'])
})

test('a native without rounds is skipped', () => {
  const result = roster([native({ rounds: [] })])
  expect(result.slots[4].instances).toEqual([])
  expect(result.others).toEqual([])
})

test('idle rows use configured models instead of the last instance model', () => {
  const result = roster(
    [native({ rounds: [{ startedAt: 100, endedAt: 200, status: 'stopped' }] })],
    config({ council: { seats: { alpha: { model: 'seat-model' } } } }))
  expect(result.slots[1].model).toBe('code-reader-model')
  expect(result.slots[4].model).toBe('architect-model')
  expect(result.slots[4].instances[0].isActive).toBe(false)
  expect(result.slots[7].model).toBe('seat-model')
})

test('council shows a model only when its active seats share one', () => {
  expect(roster([], config()).slots[7].model).toBeUndefined()
  expect(roster([], config({ disabledAgents: ['councillor:beta'] })).slots[7].model).toBe('alpha-model')
  expect(roster([], DEFAULTS).slots[7].model).toBeUndefined()
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

test('every role is a native slot with its default model', () => {
  for (const role of ['code-reader', 'docs-reader', 'developer', 'architect', 'ux', 'git'] as const) {
    const idle = roster([], DEFAULTS).slots.find(s => s.name === role)!
    expect(idle).toEqual(expect.objectContaining({ state: 'idle', model: DEFAULTS.agents[role].model }))
    const result = roster([native({ role, type: `pantheon:${role}` })], DEFAULTS)
    expect(result.slots.find(s => s.name === role)).toEqual(expect.objectContaining({ state: 'active' }))
    expect(result.others).toEqual([])
  }
  expect(roster([], { ...DEFAULTS, disabledAgents: ['architect'] }).slots[4].state).toBe('off')
})

test('seats do not disable the council one by one', () => {
  expect(roster([], DEFAULTS).slots[7].state).toBe('idle')
  expect(roster([], { ...DEFAULTS, disabledAgents: ['councillor:alpha'] }).slots[7].state).toBe('idle')
  expect(roster([], { ...DEFAULTS, disabledAgents: ['council'] }).slots[7].state).toBe('off')
  expect(roster([], { ...DEFAULTS, disabledAgents: Object.keys(DEFAULTS.council.seats).map(n => `councillor:${n}`) }).slots[7].state).toBe('off')
})
