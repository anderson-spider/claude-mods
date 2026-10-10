import { expect, test } from 'claude-code/testing'
import { DEFAULT_LIMITS, DEFAULT_PRIVACY, branchOnly, eligible, ids, nextPhase, parseFlow, phaseOf, required, topoOrder } from '../hooks/jevflow/flow'
import type { Flow } from '../hooks/jevflow/types'

// Ported from JevFlow tests/test_flow_state.py (flow parsing) and tests/test_policy.py (branch-only
// phases). The dropped features (flow mode, gates, notify, dynamic phases) have no cases here; the
// tests that they are rejected as unknown keys are below.

type Raw = Record<string, unknown>

const GOAL = 'Build a CLI todo app with tests'
const BASE: Raw = {
  schema_version: 1,
  flow_version: '3',
  goal: GOAL,
  phases: [
    { id: 'scaffold', name: 'Scaffold', done_when: 'layout exists', check: 'test -f todo/cli.py' },
    { id: 'implement', name: 'Implement', done_when: 'commands work' },
    { id: 'test', name: 'Tests', done_when: 'suite passes', check: 'pytest -q', loop: { max_iterations: 4, until: 'pytest -q' }, on_fail: 'debug' },
    { id: 'debug', name: 'Debug', done_when: 'failure understood', depends_on: ['implement'] },
  ],
  limits: { max_blocks_per_session: 6, confidence: { auto: 0.85 } },
  privacy: { send_diff: false },
}
const BRANCH: Raw = {
  goal: GOAL,
  phases: [
    { id: 'implement', name: 'Implement', done_when: 'commands work' },
    { id: 'test', name: 'Tests', done_when: 'suite passes', check: 'pytest -q', on_fail: 'debug' },
    { id: 'debug', name: 'Debug', done_when: 'root cause fixed', depends_on: [] },
  ],
}

const withTop = (over: Raw): Raw => ({ ...BASE, ...over })
const withPhase = (i: number, over: Raw): Raw => ({
  ...BASE,
  phases: (BASE.phases as Raw[]).map((p, j) => (j === i ? { ...p, ...over } : p)),
})
const without = (raw: Raw, key: string): Raw => {
  const copy = { ...raw }
  delete copy[key]
  return copy
}

/** The parsed flow; throws with the errors when the flow is rejected. */
const parsed = (raw: unknown): Flow => {
  const result = parseFlow(raw)
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.flow
}
/** The error text of a flow that must be rejected; throws when it is accepted. */
const rejected = (raw: unknown): string => {
  const result = parseFlow(raw)
  if (result.ok) throw new Error('expected the flow to be rejected')
  return result.errors.join('\n')
}

// --- valid flows ---

test('parses the full flow: ids, linear and explicit dependencies, loop, on_fail, merged limits', () => {
  const flow = parsed(BASE)
  expect(ids(flow)).toEqual(['scaffold', 'implement', 'test', 'debug'])
  expect(flow.flow_version).toBe('3')
  expect(phaseOf(flow, 'implement').depends_on).toEqual(['scaffold'])
  expect(phaseOf(flow, 'debug').depends_on).toEqual(['implement'])
  expect(phaseOf(flow, 'test').loop).toEqual({ max_iterations: 4, until: 'pytest -q' })
  expect(phaseOf(flow, 'test').on_fail).toBe('debug')
  expect(flow.limits.confidence).toEqual({ auto: 0.85, review: 0.5, flag: 0.7, trust_check: 0.9 })
  expect(flow.limits.max_restarts).toBe(5)
  expect(flow.limits.hang_minutes).toBe(10)
  expect(flow.privacy).toEqual({ send_diff: false })
})

test('a minimal flow gets JevFlow defaults', () => {
  const flow = parsed({ goal: 'g', phases: [{ id: 'a', name: 'A', done_when: 'x' }] })
  expect(flow.schema_version).toBe(1)
  expect(flow.flow_version).toBe('1')
  expect(flow.title).toBe('')
  expect(flow.privacy).toEqual(DEFAULT_PRIVACY)
  expect(flow.limits).toEqual(DEFAULT_LIMITS)
  expect(phaseOf(flow, 'a').depends_on).toEqual([])
  expect(phaseOf(flow, 'a').check).toBeUndefined()
  expect(phaseOf(flow, 'a').side_effect).toBe(false)
})

test('an integer flow_version is kept as its text', () => {
  expect(parsed(withTop({ flow_version: 7 })).flow_version).toBe('7')
})

test('a parse does not change the defaults it merges with', () => {
  parsed(withTop({ limits: { confidence: { auto: 0.4, review: 0.1 } } }))
  expect(DEFAULT_LIMITS.confidence.auto).toBe(0.8)
  expect(DEFAULT_LIMITS.confidence.review).toBe(0.5)
})

test('the title is trimmed and counted in code points, at most 80', () => {
  expect(parsed(withTop({ title: '  Toy files  ' })).title).toBe('Toy files')
  expect(parsed(withTop({ title: 'x'.repeat(80) })).title).toBe('x'.repeat(80))
  expect(rejected(withTop({ title: 'x'.repeat(81) }))).toContain('at most 80')
  expect(rejected(withTop({ title: 3 }))).toContain('title must be a string')
})

test('eligibility follows the dependency graph', () => {
  const dag = parsed({
    goal: GOAL,
    phases: [
      { id: 'a', name: 'A', done_when: 'x', depends_on: [] },
      { id: 'b', name: 'B', done_when: 'x', depends_on: [] },
      { id: 'c', name: 'C', done_when: 'x', depends_on: ['a', 'b'] },
    ],
  })
  expect(eligible(dag, {})).toEqual(['a', 'b'])
  expect(eligible(dag, { a: 'done' })).toEqual(['b'])
  expect(eligible(dag, { a: 'done', b: 'done' })).toEqual(['c'])
  expect(eligible(dag, { a: 'done', b: 'done', c: 'done' })).toEqual([])
})

test('the join waits for every dependency of a fan-in phase', () => {
  const flow = parsed({
    goal: GOAL,
    phases: [
      { id: 'api', name: 'API', done_when: 'api done', depends_on: [] },
      { id: 'cli', name: 'CLI', done_when: 'cli done', depends_on: ['api'] },
      { id: 'docs', name: 'Docs', done_when: 'docs done', depends_on: [] },
      { id: 'ship', name: 'Ship', done_when: 'shipped', depends_on: ['cli', 'docs'] },
    ],
  })
  expect(eligible(flow, {})).toEqual(['api', 'docs'])
  expect(eligible(flow, { api: 'done' })).toEqual(['cli', 'docs'])
  expect(eligible(flow, { api: 'done', cli: 'done' })).toEqual(['docs'])
})

test('topological order puts a forward reference after its dependency', () => {
  const flow = parsed({
    goal: GOAL,
    phases: [
      { id: 'b', name: 'B', done_when: 'x', depends_on: ['a'] },
      { id: 'a', name: 'A', done_when: 'x', depends_on: [] },
    ],
  })
  expect(topoOrder(flow)).toEqual(['a', 'b'])
})

test('nextPhase follows declaration order and throws for an unknown id', () => {
  const flow = parsed(BASE)
  expect(nextPhase(flow, 'scaffold')).toBe('implement')
  expect(nextPhase(flow, 'debug')).toBeUndefined()
  expect(() => nextPhase(flow, 'nope')).toThrow()
  expect(() => phaseOf(flow, 'nope')).toThrow()
})

test('an on_fail target nothing depends on is branch-only: never eligible, not required', () => {
  const flow = parsed(BRANCH)
  expect(branchOnly(flow)).toEqual(['debug'])
  expect(required(flow)).toEqual(['implement', 'test'])
  expect(eligible(flow, {})).toEqual(['implement'])
  expect(eligible(flow, {})).not.toContain('debug')
})

test('a side_effect phase with a check is accepted', () => {
  const flow = parsed(withPhase(1, { check: 'make build', side_effect: true }))
  expect(phaseOf(flow, 'implement').side_effect).toBe(true)
})

// --- rejected flows ---

test('a flow must be a JSON object', () => {
  expect(rejected([])).toContain('JSON object')
  expect(rejected(null)).toContain('JSON object')
  expect(rejected('goal')).toContain('JSON object')
})

test('goal is required and non-empty', () => {
  expect(rejected(without(BASE, 'goal'))).toContain('goal')
  expect(rejected(withTop({ goal: '   ' }))).toContain("'goal' must be a non-empty string")
})

test('phases must be a non-empty list', () => {
  expect(rejected(withTop({ phases: [] }))).toContain("'phases' must be a non-empty list")
})

test('unknown top-level keys are rejected, including the dropped mode, gates and notify', () => {
  expect(rejected(withTop({ gaol: 'typo' }))).toContain('unknown top-level keys')
  expect(rejected(withTop({ mode: 'observe' }))).toContain("['mode']")
  expect(rejected(withTop({ gates: {} }))).toContain("['gates']")
  expect(rejected(withTop({ notify: {} }))).toContain("['notify']")
})

test('unknown phase keys are rejected, including the dropped dynamic flag', () => {
  expect(rejected(withPhase(0, { chek: 'typo' }))).toContain('unknown keys')
  expect(rejected(withPhase(0, { dynamic: true }))).toContain("['dynamic']")
})

test('phase ids are unique', () => {
  expect(rejected(withPhase(1, { id: 'scaffold' }))).toContain('duplicate phase ids')
})

test('phase ids match the pattern, are at most 40 characters and are not reserved', () => {
  expect(rejected(withPhase(0, { id: 'Bad Id' }))).toContain('must match')
  expect(rejected(withPhase(0, { id: 'unclear' }))).toContain('reserved')
  expect(parsed(withPhase(0, { id: 'a'.repeat(40) })).phases[0]?.id).toBe('a'.repeat(40))
  expect(rejected(withPhase(0, { id: 'a'.repeat(41) }))).toContain('must match')
})

test('an unknown dependency or a self dependency is rejected', () => {
  expect(rejected(withPhase(3, { depends_on: ['nope'] }))).toContain('unknown phase')
  expect(rejected(withPhase(3, { depends_on: ['debug'] }))).toContain('depends_on itself')
})

test('a depends_on cycle is rejected and the message names every phase in it', () => {
  const message = rejected({
    goal: GOAL,
    phases: [
      { id: 'a', name: 'A', done_when: 'x', depends_on: ['c'] },
      { id: 'b', name: 'B', done_when: 'x', depends_on: ['a'] },
      { id: 'c', name: 'C', done_when: 'x', depends_on: ['b'] },
    ],
  })
  expect(message).toContain('cycle')
  expect(message).toContain('a -> c -> b -> a')
})

test('depends_on must be a list of distinct ids', () => {
  expect(rejected(withPhase(3, { depends_on: 'implement' }))).toContain('must be a list of phase ids')
  expect(rejected(withPhase(3, { depends_on: ['implement', 'implement'] }))).toContain('duplicates')
})

test('a loop needs max_iterations of at least 1 and an until command', () => {
  expect(rejected(withPhase(2, { loop: { max_iterations: 0, until: 'x' } }))).toContain('max_iterations')
  expect(rejected(withPhase(2, { loop: { max_iterations: true, until: 'x' } }))).toContain('max_iterations')
  expect(rejected(withPhase(2, { loop: { max_iterations: 3 } }))).toContain("'until'")
  expect(rejected(withPhase(2, { loop: { max_iterations: 3, until: 'x', extra: 1 } }))).toContain('loop must be')
})

test('on_fail must name another existing phase', () => {
  expect(rejected(withPhase(2, { on_fail: 'nope' }))).toContain('on_fail unknown phase')
  expect(rejected(withPhase(2, { on_fail: 'test' }))).toContain('cannot target itself')
})

test('a flow whose every phase is a branch-only target is rejected', () => {
  const message = rejected({
    goal: GOAL,
    phases: [
      { id: 'a', name: 'A', done_when: 'x', depends_on: [], on_fail: 'b' },
      { id: 'b', name: 'B', done_when: 'x', depends_on: [], on_fail: 'a' },
    ],
  })
  expect(message).toContain('every phase is a branch-only on_fail target')
})

test('schema_version must be 1, and a boolean is not a version', () => {
  expect(rejected(withTop({ schema_version: 2 }))).toContain('schema_version')
  expect(rejected(withTop({ schema_version: true }))).toContain('schema_version')
})

test('flow_version must be a non-empty string or an integer', () => {
  expect(rejected(withTop({ flow_version: '  ' }))).toContain('flow_version must be a non-empty string or integer')
  expect(rejected(withTop({ flow_version: true }))).toContain('flow_version must be a non-empty string or integer')
})

test('limits: restarts may be zero, other limits are positive, confidence is in [0, 1] with review <= auto', () => {
  expect(rejected(withTop({ limits: { max_restarts: -1 } }))).toContain('max_restarts must be an integer >= 0')
  expect(parsed(withTop({ limits: { max_restarts: 0 } })).limits.max_restarts).toBe(0)
  expect(rejected(withTop({ limits: { max_restrats: 3 } }))).toContain('unknown keys')
  expect(rejected(withTop({ limits: { confidence: { auto: 1.5 } } }))).toContain('[0, 1]')
  expect(rejected(withTop({ limits: { confidence: { auto: 0.4, review: 0.6 } } }))).toContain('review must be <= auto')
  expect(rejected(withTop({ limits: { confidence: { flg: 0.4 } } }))).toContain('unknown keys')
})

test('privacy holds only send_diff, as a boolean', () => {
  expect(rejected(withTop({ privacy: { send_diff: 'no' } }))).toContain('privacy.send_diff must be a boolean')
  expect(rejected(withTop({ privacy: { other: 1 } }))).toContain("only 'send_diff'")
})

test('a side_effect phase needs a check, and the flag is a boolean', () => {
  expect(rejected(withPhase(1, { side_effect: true }))).toContain("side_effect phases need a 'check'")
  expect(rejected(withPhase(1, { side_effect: 'yes' }))).toContain('side_effect must be a boolean')
})
