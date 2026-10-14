import { expect, test } from 'claude-code/testing'
import { defaultOf, DIFFICULTIES, QUESTIONS, DURATION_GROUPS, GROUP_OF_DURATION, ROLE_CELLS, ROUTES, routeOf } from '../hooks/router'
import { EFFORTS, MODELS, ROLES, SPECS } from '../hooks/roles'

const TABLE: Record<(typeof DIFFICULTIES)[number], [string, string, string]> = {
  trivial: ['haiku/low', 'haiku/low', 'haiku/medium'],
  easy: ['sonnet/low', 'sonnet/medium', 'sonnet/medium'],
  moderate: ['sonnet/medium', 'sonnet/high', 'sonnet/high'],
  hard: ['opus/low', 'opus/medium', 'opus/high'],
  expert: ['opus/high', 'fable/high', 'fable/high'],
}

test('the table holds every difficulty and duration group cell by cell', () => {
  expect(DIFFICULTIES).toEqual(['trivial', 'easy', 'moderate', 'hard', 'expert'])
  expect(DURATION_GROUPS).toEqual(['short', 'medium', 'long'])
  expect(Object.keys(ROUTES)).toEqual([...DIFFICULTIES])
  for (const difficulty of DIFFICULTIES) {
    expect(Object.keys(ROUTES[difficulty])).toEqual([...DURATION_GROUPS])
    expect(DURATION_GROUPS.map(g => `${ROUTES[difficulty][g].model}/${ROUTES[difficulty][g].effort}`)).toEqual(TABLE[difficulty])
  }
})

test('every cell is a known model and effort and the levels match the questions', () => {
  for (const difficulty of DIFFICULTIES) for (const group of DURATION_GROUPS) {
    expect(MODELS).toContain(ROUTES[difficulty][group].model)
    expect(EFFORTS).toContain(ROUTES[difficulty][group].effort)
  }
  expect(DIFFICULTIES).toHaveLength(QUESTIONS.difficulty.criteria.length)
  expect(GROUP_OF_DURATION).toHaveLength(QUESTIONS.duration.criteria.length)
  for (const group of GROUP_OF_DURATION) expect(DURATION_GROUPS).toContain(group)
})

test('duration levels 0 and 1 are short, 2 medium and 3 long when routing by level', () => {
  expect(GROUP_OF_DURATION).toEqual(['short', 'short', 'medium', 'long'])
  DIFFICULTIES.forEach((difficulty, d) => GROUP_OF_DURATION.forEach((group, t) => expect(routeOf(d, t)).toEqual(ROUTES[difficulty][group])))
  expect(routeOf(4, 1)).toEqual({ model: 'opus', effort: 'high' })
  expect(routeOf(4, 2)).toEqual({ model: 'fable', effort: 'high' })
  for (const [d, t] of [[-1, 0], [5, 0], [0, -1], [0, 4], [1.5, 0]]) expect(() => routeOf(d!, t!)).toThrow('level out of range')
})

test('role defaults are table cells and the registered definitions carry them', () => {
  expect(ROLE_CELLS).toEqual({
    analyst: { difficulty: 'easy', group: 'medium' }, developer: { difficulty: 'moderate', group: 'medium' },
    reviewer: { difficulty: 'hard', group: 'short' }, architect: { difficulty: 'hard', group: 'medium' },
  })
  expect(ROLES.map(role => `${role} ${defaultOf(role).model}/${defaultOf(role).effort}`)).toEqual(['analyst sonnet/medium', 'developer sonnet/high', 'reviewer opus/low', 'architect opus/medium'])
  for (const role of ROLES) expect([SPECS[role].model, SPECS[role].effort]).toEqual([defaultOf(role).model, defaultOf(role).effort])
})
