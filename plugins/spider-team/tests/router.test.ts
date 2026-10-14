import { expect, test } from 'claude-code/testing'
import { CALIBRATION, defaultOf, DIFFICULTIES, DURATION_GROUPS, GROUP_OF_DURATION, higher, JUDGE_FIRE, JUDGE_FLAGS, JUDGE_QUESTIONS, judgedShort, LADDER, pairOf, POLICY, PRICES, QUESTIONS, ROLE_POLICY, ROUTES, routeOf } from '../hooks/router'
import { EFFORTS, MODELS, ROLES, SPECS } from '../hooks/roles'

const TABLE: Record<(typeof DIFFICULTIES)[number], [string, string, string]> = {
  trivial: ['haiku/medium', 'haiku/medium', 'haiku/high'],
  easy: ['haiku/high', 'haiku/high', 'haiku/xhigh'],
  moderate: ['haiku/xhigh', 'sonnet/high', 'sonnet/high'],
  hard: ['opus/low', 'opus/medium', 'opus/high'],
  expert: ['opus/high', 'opus/high', 'opus/high'],
}

test('the table holds every difficulty and duration group cell by cell', () => {
  expect(DIFFICULTIES).toEqual(['trivial', 'easy', 'moderate', 'hard', 'expert'])
  expect(DURATION_GROUPS).toEqual(['short', 'medium', 'long'])
  expect(Object.keys(ROUTES)).toEqual([...DIFFICULTIES])
  for (const difficulty of DIFFICULTIES) {
    expect(Object.keys(ROUTES[difficulty])).toEqual([...DURATION_GROUPS])
    expect(DURATION_GROUPS.map(g => ROUTES[difficulty][g])).toEqual(TABLE[difficulty])
  }
})

test('the capacity ladder is the one ordered list every cell, floor and default belongs to', () => {
  expect(LADDER).toEqual(['haiku/medium', 'haiku/high', 'haiku/xhigh', 'sonnet/high', 'opus/low', 'opus/medium', 'opus/high'])
  for (const difficulty of DIFFICULTIES) for (const group of DURATION_GROUPS) expect(LADDER).toContain(ROUTES[difficulty][group])
  for (const role of ROLES) { expect(LADDER).toContain(ROLE_POLICY[role].floor); expect(LADDER).toContain(ROLE_POLICY[role].default) }
  for (const rung of LADDER) {
    const { model, effort } = pairOf(rung)
    expect(MODELS).toContain(model); expect(EFFORTS).toContain(effort)
  }
  expect(higher('haiku/high', 'sonnet/high')).toBe('sonnet/high')
  expect(higher('opus/medium', 'haiku/xhigh')).toBe('opus/medium')
  expect(higher('haiku/high', 'haiku/high')).toBe('haiku/high')
})

test('no pair is below its role floor for any cell, Haiku never runs at low and Fable is out', () => {
  expect(MODELS).toEqual(['haiku', 'sonnet', 'opus'])
  expect(Object.keys(PRICES)).toEqual([...MODELS])
  for (const rung of LADDER) { expect(rung).not.toContain('fable'); if (rung.startsWith('haiku')) expect(rung).not.toBe('haiku/low') }
  for (const role of ROLES) {
    const floor = LADDER.indexOf(ROLE_POLICY[role].floor)
    expect(LADDER.indexOf(ROLE_POLICY[role].default)).toBeGreaterThanOrEqual(floor)
    DIFFICULTIES.forEach((_, d) => GROUP_OF_DURATION.forEach((_, t) => {
      const routed = routeOf(role, d, t)
      const rung = `${routed.pair.model}/${routed.pair.effort}`
      expect(LADDER.indexOf(rung as never)).toBeGreaterThanOrEqual(floor)
      expect(routed.floorApplied).toBe(LADDER.indexOf(ROUTES[DIFFICULTIES[d]!][GROUP_OF_DURATION[t]!]) < floor)
    }))
  }
})

test('duration levels 0 and 1 are short, 2 medium and 3 long, and the floor lifts a weaker cell', () => {
  expect(GROUP_OF_DURATION).toEqual(['short', 'short', 'medium', 'long'])
  DIFFICULTIES.forEach((difficulty, d) => GROUP_OF_DURATION.forEach((group, t) => expect(routeOf('analyst', d, t).cell).toEqual(pairOf(ROUTES[difficulty][group]))))
  expect(routeOf('analyst', 4, 1)).toEqual({ cell: { model: 'opus', effort: 'high' }, pair: { model: 'opus', effort: 'high' }, floorApplied: false })
  // Trivial and short is haiku/medium: the analyst's floor keeps it, the opus roles' floors lift it.
  expect(routeOf('analyst', 0, 0)).toEqual({ cell: { model: 'haiku', effort: 'medium' }, pair: { model: 'haiku', effort: 'medium' }, floorApplied: false })
  expect(routeOf('planner', 0, 0)).toEqual({ cell: { model: 'haiku', effort: 'medium' }, pair: { model: 'opus', effort: 'low' }, floorApplied: true })
  expect(routeOf('reviewer', 2, 0)).toEqual({ cell: { model: 'haiku', effort: 'xhigh' }, pair: { model: 'opus', effort: 'low' }, floorApplied: true })
  expect(routeOf('planner', 3, 0)).toEqual({ cell: { model: 'opus', effort: 'low' }, pair: { model: 'opus', effort: 'low' }, floorApplied: false })
  for (const [d, t] of [[-1, 0], [5, 0], [0, -1], [0, 4], [1.5, 0]]) expect(() => routeOf('analyst', d!, t!)).toThrow('level out of range')
})

test('role floors and defaults are fixed and the registered definitions carry the defaults', () => {
  expect(ROLE_POLICY).toEqual({
    analyst: { floor: 'haiku/medium', default: 'haiku/high' }, planner: { floor: 'opus/low', default: 'opus/medium' },
    reviewer: { floor: 'opus/low', default: 'opus/medium' },
  })
  expect(ROLES.map(role => `${role} ${defaultOf(role).model}/${defaultOf(role).effort}`)).toEqual(['analyst haiku/high', 'planner opus/medium', 'reviewer opus/medium'])
  for (const role of ROLES) expect([SPECS[role].model, SPECS[role].effort]).toEqual([defaultOf(role).model, defaultOf(role).effort])
})

test('the questions judge the work itself and ask for human-expert time, not the length of the brief', () => {
  expect(QUESTIONS.difficulty.instructions).toContain('Judge the work itself, not the length or detail of the brief')
  expect(QUESTIONS.difficulty.instructions).toContain('a long list of constraints, checks or acceptance criteria does not make a task harder')
  expect(QUESTIONS.difficulty.criteria).toEqual([
    'Trivial: a one-line or purely mechanical change, such as a rename, a typo, a constant or a version bump', 'Easy: small, well-understood change in one place, such as adjusting one layout line or adding a field to an output, with its test', 'Moderate: needs some understanding of the surrounding code, such as a small feature across two or three files or a bug whose cause is known',
    'Hard: subtle logic across several interacting parts, or a root cause still to be found, such as an ordering or race bug or a refactor that must keep several contracts', 'Expert: architecture, concurrency, security, or deep domain reasoning, such as a new protocol, a security boundary or a redesign across modules',
  ])
  // Human-expert time, the SWE-bench Verified buckets: Jev cannot estimate a coding agent's own time.
  expect(QUESTIONS.duration.instructions).toBe('How long would an experienced engineer who already knows this codebase need to finish this task?')
  expect(QUESTIONS.duration.criteria).toEqual(['Under 15 minutes: a mechanical edit or a one-line fix', '15 minutes to 1 hour: a small change in one or two files with its tests', '1 to 4 hours: a feature or fix across several files, with tests and docs', 'More than 4 hours: a new subsystem, a migration, or an investigation with no known cause'])
  expect(POLICY).toEqual({ under: 1, over: 1.25 })
})

test('the questions match the levels and the prices are the October 2026 list prices', () => {
  expect(DIFFICULTIES).toHaveLength(QUESTIONS.difficulty.criteria.length)
  expect(GROUP_OF_DURATION).toHaveLength(QUESTIONS.duration.criteria.length)
  for (const group of GROUP_OF_DURATION) expect(DURATION_GROUPS).toContain(group)
  expect(PRICES).toEqual({
    haiku: { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
    sonnet: { input: 2, output: 10, cacheWrite: 2.50, cacheRead: 0.10 },
    opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.20 },
  })
})

test('the calibration that tags each decision line is 5', () => {
  // Bump it with any change to QUESTIONS, POLICY, ROUTES or the roles' floors; the stats judge Jev only under the current one.
  expect(CALIBRATION).toBe(5)
})

test('the judge asks three yes/no questions about report.text, one flaw each, and a run is short below 0.5 finished or above 0.5 on a flaw', () => {
  expect(JUDGE_FLAGS).toEqual(['finished', 'failingChecks', 'blocked'])
  expect(JUDGE_QUESTIONS).toEqual({
    finished: { type: 'noul', instructions: 'Does `report.text` say the agent completed everything it was asked to do?' },
    failingChecks: { type: 'noul', instructions: 'Does `report.text` report a failing test, check or build that it left unresolved?' },
    blocked: { type: 'noul', instructions: 'Does `report.text` say the agent stopped, was blocked, or needs help or a decision before the work can be finished?' },
  })
  expect(JUDGE_FIRE).toBe(0.5)
  expect(judgedShort({ finished: 0.5, failingChecks: 0.5, blocked: 0.5 })).toBe(false)
  expect(judgedShort({ finished: 0.49, failingChecks: 0, blocked: 0 })).toBe(true)
  expect(judgedShort({ finished: 1, failingChecks: 0.51, blocked: 0 })).toBe(true)
  expect(judgedShort({ finished: 1, failingChecks: 0, blocked: 0.51 })).toBe(true)
  // The judge does not route: its questions are not routing questions and leave the calibration as it is.
  for (const flag of JUDGE_FLAGS) expect(Object.keys(QUESTIONS)).not.toContain(flag)
  expect(CALIBRATION).toBe(5)
})
