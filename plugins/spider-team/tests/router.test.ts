import { expect, test } from 'claude-code/testing'
import { defaultOf, DIFFICULTIES, DURATION_GROUPS, GROUP_OF_DURATION, higher, LADDER, pairOf, POLICY, PRICES, QUESTIONS, ROLE_POLICY, ROUTES, routeOf } from '../hooks/router'
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
  // Trivial and short is haiku/medium: the analyst's floor keeps it, the developer's and the opus roles' lift it.
  expect(routeOf('analyst', 0, 0)).toEqual({ cell: { model: 'haiku', effort: 'medium' }, pair: { model: 'haiku', effort: 'medium' }, floorApplied: false })
  expect(routeOf('developer', 0, 0)).toEqual({ cell: { model: 'haiku', effort: 'medium' }, pair: { model: 'haiku', effort: 'high' }, floorApplied: true })
  expect(routeOf('reviewer', 2, 0)).toEqual({ cell: { model: 'haiku', effort: 'xhigh' }, pair: { model: 'opus', effort: 'low' }, floorApplied: true })
  expect(routeOf('architect', 3, 0)).toEqual({ cell: { model: 'opus', effort: 'low' }, pair: { model: 'opus', effort: 'low' }, floorApplied: false })
  for (const [d, t] of [[-1, 0], [5, 0], [0, -1], [0, 4], [1.5, 0]]) expect(() => routeOf('analyst', d!, t!)).toThrow('level out of range')
})

test('role floors and defaults are fixed and the registered definitions carry the defaults', () => {
  expect(ROLE_POLICY).toEqual({
    analyst: { floor: 'haiku/medium', default: 'haiku/high' }, developer: { floor: 'haiku/high', default: 'sonnet/high' },
    architect: { floor: 'opus/low', default: 'opus/medium' }, reviewer: { floor: 'opus/low', default: 'opus/medium' },
  })
  expect(ROLES.map(role => `${role} ${defaultOf(role).model}/${defaultOf(role).effort}`)).toEqual(['analyst haiku/high', 'developer sonnet/high', 'reviewer opus/medium', 'architect opus/medium'])
  for (const role of ROLES) expect([SPECS[role].model, SPECS[role].effort]).toEqual([defaultOf(role).model, defaultOf(role).effort])
})

test('the questions judge the work itself on a coding agent\'s time scale, not the length of the brief', () => {
  expect(QUESTIONS.difficulty.instructions).toContain('Judge the work itself, not the length or detail of the brief')
  expect(QUESTIONS.difficulty.instructions).toContain('a long list of constraints, checks or acceptance criteria does not make a task harder')
  expect(QUESTIONS.difficulty.criteria).toEqual([
    'Trivial: a one-line or purely mechanical change', 'Easy: small, well-understood change in one place', 'Moderate: needs some understanding of the surrounding code',
    'Hard: subtle logic across several interacting parts, or a root cause still to be found', 'Expert: architecture, concurrency, security, or deep domain reasoning',
  ])
  expect(QUESTIONS.duration.criteria).toEqual(['Under 3 minutes', '3 to 10 minutes', '10 to 30 minutes', 'More than 30 minutes'])
  expect(POLICY).toEqual({ under: 1.25, over: 1 })
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
