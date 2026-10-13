import { expect, test } from 'claude-code/testing'
import { choose, distributions, penalty, POLICY, QUESTIONS } from '../hooks/effort'
import type { Distributions } from '../hooks/effort'
import type { Answers } from '../hooks/jev'

const point = (difficulty: number, duration: number, scope: number): Distributions => ({
  difficulty: { [difficulty]: 1 }, duration: { [duration]: 1 }, scope: { [scope]: 1 },
})

test('each role chooses its allowed efforts from distributions', () => {
  for (const role of ['developer', 'architect'] as const) {
    expect(choose(role, point(0, 0, 0))).toBe('medium')
    expect(choose(role, point(3, 1, 2))).toBe('high')
    expect(choose(role, point(4, 3, 3))).toBe('xhigh')
  }
  expect(choose('analyst', point(0, 0, 0))).toBe('low')
  expect(choose('analyst', point(0, 1, 0))).toBe('medium')
  expect(choose('analyst', point(4, 3, 3))).toBe('high')
})

test('penalty integrates probabilities with asymmetric weights and tolerance, rounding like herdr-router', () => {
  const dist = { difficulty: { '0': 0.5, '4': 0.5 }, duration: { '0': 1 }, scope: { '0': 0.5, '3': 0.5 } }
  // Difficulty: .5*(.5*1.5)+.5*(4*1.5)=3.375; duration: .5*.5=.25; scope: .5*(.5*.5*.5+.5*4*1.5)=1.5625.
  expect(penalty({ difficulty: 2, duration: 1, scope: 1 }, dist)).toBe(5.1875)
  expect(penalty({ difficulty: 2, duration: 1, scope: 1 }, dist)).not.toBe(penalty({ difficulty: 2, duration: 1, scope: 1 }, point(2, 0, 1.5)))
  // A high-difficulty tail changes the choice even though duration and scope are both minimal.
  expect(choose('developer', { ...point(0, 0, 0), difficulty: { '0': 0.25, '4': 0.75 } })).toBe('high')
})

test('equal penalties keep the cheaper effort', () => {
  // Mixed durations charge both tails; a mean-only calculation would pick low for the first distribution.
  const dists = { ...point(0, 0, 0), duration: { '0': 0.5, '1': 0.5 } }
  expect(choose('analyst', dists)).toBe('medium')
  const equal = { ...point(0, 0, 0), duration: { '0': 0.8, '1': 0.2 } }
  expect(penalty(POLICY.candidates.luna[0].point, equal)).toBe(penalty(POLICY.candidates.luna[1].point, equal))
  expect(choose('analyst', equal)).toBe('low')
})

test('all three score questions carry concrete criteria', () => {
  expect(Object.keys(QUESTIONS)).toEqual(['difficulty', 'duration', 'scope'])
  expect(Object.values(QUESTIONS).map(q => [q.type, q.criteria.length])).toEqual([['score', 5], ['score', 4], ['score', 4]])
})

test('probabilities are normalized and malformed dimensions are refused', () => {
  const answers = { difficulty: { probabilities: { '0': 0.2, '1': 0.2 } }, duration: { probabilities: { '1': 1 } }, scope: { probabilities: { '2': 1 } } }
  expect(distributions(answers).difficulty).toEqual({ '0': 0.5, '1': 0.5 })
  for (const probs of [undefined, [], {}, { '0': 0 }, { '0': -1 }, { '0': '1' }, { '0': true }, { '0': NaN }, { '0': Infinity }, { '0': 2 }, { '4': 1 }, { '0.5': 1 }, { secret: 1 }]) {
    expect(() => distributions({ ...answers, duration: { probabilities: probs } } as Answers)).toThrow('probabilities')
  }
  expect(() => distributions({ difficulty: answers.difficulty })).toThrow('probabilities')
})
