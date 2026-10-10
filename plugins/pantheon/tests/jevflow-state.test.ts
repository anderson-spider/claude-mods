import { expect, test } from 'claude-code/testing'
import { parseFlow } from '../hooks/jevflow/flow'
import {
  HISTORY_CAP, MAX_AGENTS, agentKey, byPhase, claim, newState, record, setPhaseStatus, touchAgent, validateState,
} from '../hooks/jevflow/state'
import type { Flow, FlowState } from '../hooks/jevflow/types'

// Ported from JevFlow tests/test_flow_state.py (state, journal, reconciliation) and
// tests/test_multi.py (agents). File I/O cases (atomic save, concurrent writers, load from disk)
// have no counterpart: the port takes data in and returns data out.

const GOAL = 'Build a CLI todo app with tests'

/** The parsed flow; throws with the errors when the flow is rejected. */
function parsed(raw: unknown): Flow {
  const result = parseFlow(raw)
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.flow
}

const flow: Flow = parsed({
  schema_version: 1,
  flow_version: '3',
  goal: GOAL,
  phases: [
    { id: 'scaffold', name: 'Scaffold', done_when: 'layout exists', check: 'test -f todo/cli.py' },
    { id: 'implement', name: 'Implement', done_when: 'commands work' },
    { id: 'test', name: 'Tests', done_when: 'suite passes', check: 'pytest -q', loop: { max_iterations: 4, until: 'pytest -q' }, on_fail: 'debug' },
    { id: 'debug', name: 'Debug', done_when: 'failure understood', depends_on: ['implement'] },
  ],
})

/** The state after a claim; throws with the reason when the claim is refused. */
const claimed = (result: FlowState | string): FlowState => {
  if (typeof result === 'string') throw new Error(result)
  return result
}

// --- newState and the journal ---

test('newState activates the first eligible phase and leaves the rest pending', () => {
  const state = newState(flow, 100)
  expect(state.current_phase).toBe('scaffold')
  expect(state.phase_status).toEqual({ scaffold: 'active', implement: 'pending', test: 'pending', debug: 'pending' })
  expect(state.phase_attempts).toEqual({ scaffold: 1 })
  expect(state.flow_version).toBe('3')
  expect(state).toMatchObject({ state_schema: 1, done: false, started_at: 100, updated_at: 100, history: [], agents: {} })
})

test('record appends a numbered entry stamped with now and the current phase, without mutating the input', () => {
  const before = newState(flow, 100)
  const after = record(before, 'stop', { decision: 'BLOCK', condition: 'stuck', reason: 'no progress' }, 105.1234)
  expect(after.history).toEqual([{ ts: 105.123, seq: 1, event: 'stop', decision: 'BLOCK', condition: 'stuck', phase: 'scaffold', reason: 'no progress' }])
  expect(after.seq).toBe(1)
  expect(record(after, 'x', {}, 106).history[1]?.seq).toBe(2)
  expect(after.updated_at).toBe(105.1234)
  expect(before.history).toEqual([])
  expect(before.updated_at).toBe(100)
})

test('record keeps an explicit phase', () => {
  const state = record(newState(flow, 100), 'stop', { decision: 'ADVANCE', condition: 'task_done', phase: 'implement' }, 101)
  expect(state.history[0]?.phase).toBe('implement')
})

test('the journal keeps only the newest HISTORY_CAP entries', () => {
  let state = newState(flow, 0)
  for (let i = 0; i < HISTORY_CAP + 25; i++) state = record(state, 'e', { reason: `e${i}` }, i)
  expect(state.history).toHaveLength(HISTORY_CAP)
  expect(state.history[0]?.reason).toBe('e25')
  expect(state.history[HISTORY_CAP - 1]?.reason).toBe(`e${HISTORY_CAP + 24}`)
})

test('setPhaseStatus sets one phase and throws for an unknown phase or a status state.py does not accept', () => {
  const before = newState(flow, 100)
  const after = setPhaseStatus(before, 'scaffold', 'done')
  expect(after.phase_status.scaffold).toBe('done')
  expect(before.phase_status.scaffold).toBe('active')
  expect(() => setPhaseStatus(before, 'scaffold', 'finished' as never)).toThrow('bad phase status')
  expect(() => setPhaseStatus(before, 'scaffold', 'failed' as never)).toThrow('bad phase status')
  expect(() => setPhaseStatus(before, 'nope', 'done')).toThrow('unknown phase')
})

// --- validateState ---

test('validateState accepts a fresh state and adds no journal entry', () => {
  const state = validateState(newState(flow, 100), flow, 200)
  expect(state.history).toEqual([])
  expect(state.updated_at).toBe(100)
})

test('validateState rejects structurally invalid states by throwing StateError', () => {
  const fresh = newState(flow, 0)
  const bad: unknown[] = [
    [],
    'x',
    { current_phase: 'x' },
    { ...fresh, restarts: -1 },
    { ...fresh, jev_calls: 1.5 },
    { ...fresh, loop_iterations: [] },
    { ...fresh, phase_status: { scaffold: 'weird' } },
    { ...fresh, phase_status: { scaffold: 'failed' } },
    { ...fresh, done: 'no' },
    { ...fresh, history: {} },
  ]
  for (const raw of bad) expect(() => validateState(raw, flow, 0)).toThrow()
  expect(() => validateState({ ...fresh, restarts: -1 }, flow, 0)).toThrow('state.restarts must be a non-negative integer')
  expect(() => validateState({ ...fresh, phase_status: { scaffold: 'weird' } }, flow, 0)).toThrow("state.phase_status['scaffold'] = 'weird' is invalid")
})

test('validateState drops phases the flow no longer has and journals the change', () => {
  const stale = {
    ...newState(flow, 100),
    current_phase: 'gone',
    phase_status: { scaffold: 'done', implement: 'pending', test: 'pending', debug: 'pending', gone: 'active' },
    flow_version: '2',
  }
  const state = validateState(stale, flow, 150)
  expect(Object.keys(state.phase_status)).not.toContain('gone')
  expect(state.current_phase).toBe('implement')
  expect(state.flow_version).toBe('3')
  expect(state.history).toHaveLength(1)
  expect(state.history[0]).toMatchObject({ event: 'flow_changed', ts: 150 })
  expect(state.history[0]?.detail).toBe("removed gone; flow_version '2' -> '3'; current_phase reset to implement")
})

test('validateState adds a phase new to the flow as pending', () => {
  const partial = { ...newState(flow, 100), phase_status: { scaffold: 'done', implement: 'active', test: 'pending' } }
  const state = validateState(partial, flow, 150)
  expect(state.phase_status.debug).toBe('pending')
  expect(String(state.history[0]?.detail)).toContain('added debug')
})

test('validateState fills in the fields an older state lacks', () => {
  const raw = {
    current_phase: 'scaffold',
    phase_status: { scaffold: 'active', implement: 'pending', test: 'pending', debug: 'pending' },
    history: [],
    done: false,
    flow_version: '3',
  }
  const state = validateState(raw, flow, 150)
  expect(state).toMatchObject({
    blocks_this_session: 0, restarts: 0, jev_calls: 0, loop_iterations: {}, phase_attempts: {},
    needs_human: null, last_failure: null, review_streak: null, started_at: 150, updated_at: 150, agents: {}, history: [],
  })
})

test('validateState does not mutate its input', () => {
  const raw = {
    current_phase: 'scaffold',
    phase_status: { scaffold: 'active', implement: 'pending', test: 'pending', debug: 'pending' },
    history: [],
    done: false,
    flow_version: '3',
  }
  const before = JSON.stringify(raw)
  validateState(raw, flow, 1)
  expect(JSON.stringify(raw)).toBe(before)
  expect(raw).not.toHaveProperty('agents')
})

// --- agents ---

const lead = { sessionId: 's1abcdef' }
const sub = { sessionId: 's1abcdef', agentId: 'ag42xyz', agentType: 'pantheon:developer' }

test('touchAgent adds an agent on the current phase, counts its tools and stops, and follows the phase', () => {
  const first = touchAgent(newState(flow, 100), lead, 101, 'tool')
  expect(first.agents['session:s1abcdef']).toEqual({
    label: 'claude s1abcd', kind: 'session', session: 's1abcdef', first_at: 101, at: 101, tools: 1, stops: 0, phase: 'scaffold',
  })
  const second = touchAgent({ ...first, current_phase: 'implement' }, lead, 105, 'stop')
  expect(second.agents['session:s1abcdef']).toMatchObject({ first_at: 101, at: 105, tools: 1, stops: 1, phase: 'implement' })
  const s2 = touchAgent(newState(flow, 100), sub, 101, 'tool')
  expect(s2.agents['agent:ag42xyz']).toMatchObject({ label: 'pantheon:developer ag42xy', kind: 'subagent', type: 'pantheon:developer' })
})

test('a claim holds its phase as the role while the flow moves, and ends with the agent turn', () => {
  const held = claimed(claim(newState(flow, 100), sub, 'implement', 'developer', 102))
  expect(held.agents['agent:ag42xyz']).toMatchObject({ phase: 'implement', role: 'developer', label: 'developer', claimed: true })

  const moved = touchAgent({ ...held, current_phase: 'test' }, sub, 103, 'tool')
  expect(moved.agents['agent:ag42xyz']?.phase).toBe('implement')

  const stopped = touchAgent(moved, sub, 104, 'stop')
  expect(stopped.agents['agent:ag42xyz']?.claimed).toBeUndefined()
  expect(stopped.agents['agent:ag42xyz']?.phase).toBe('implement')

  const next = touchAgent({ ...stopped, current_phase: 'test' }, sub, 105, 'tool')
  expect(next.agents['agent:ag42xyz']?.phase).toBe('test')
})

test('a claim refuses an unknown role or phase, with the reason', () => {
  const state = newState(flow, 100)
  const badRole = claim(state, sub, 'implement', 'wizard', 102)
  expect(typeof badRole).toBe('string')
  expect(badRole).toContain("unknown role 'wizard'")
  expect(badRole).toContain('developer')
  expect(claim(state, sub, 'nope', 'developer', 102)).toContain("unknown phase 'nope'")
  expect(claim(state, {}, 'implement', 'developer', 102)).toContain('no agent')
})

test('byPhase groups agent labels by phase and leaves out agents without one', () => {
  let state = touchAgent(newState(flow, 100), lead, 101, 'tool')
  state = claimed(claim(state, sub, 'implement', 'developer', 103))
  expect(byPhase(state)).toEqual({ scaffold: ['claude s1abcd'], implement: ['developer'] })
  const base = state.agents['agent:ag42xyz']!
  const odd: FlowState = { ...state, agents: { a: { ...base, label: 'x', phase: 'constructor' }, b: { ...base, label: 'y', phase: 'constructor' }, c: { ...base, label: 'z', phase: undefined } } }
  expect(byPhase(odd)).toEqual({ constructor: ['x', 'y'] })
})

test('the agent table keeps at most MAX_AGENTS entries, dropping the least recently seen', () => {
  let state = newState(flow, 0)
  for (let i = 0; i < MAX_AGENTS + 5; i++) state = touchAgent(state, { sessionId: `s${i}` }, i, 'tool')
  const keys = Object.keys(state.agents)
  expect(keys).toHaveLength(MAX_AGENTS)
  expect(keys).not.toContain('session:s4')
  expect(keys).toContain('session:s5')
  expect(keys).toContain(`session:s${MAX_AGENTS + 4}`)
})

test('agentKey names a subagent by its id, else a session by its id, and cuts ids to 64 characters', () => {
  expect(agentKey({ agentId: 'ag42', sessionId: 's1' })).toBe('agent:ag42')
  expect(agentKey({ sessionId: 's1abcdef' })).toBe('session:s1abcdef')
  expect(agentKey({})).toBeUndefined()
  expect(agentKey({ sessionId: '' })).toBeUndefined()
  expect(agentKey({ sessionId: 'x'.repeat(100) })).toBe('session:' + 'x'.repeat(64))
})
