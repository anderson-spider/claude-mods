import { expect, test } from 'claude-code/testing'
import { choose, distributions, INVALID_PINS, parsePins, penalty, PROFILES, QUESTIONS, TASK_TYPES } from '../hooks/effort'
import type { Distributions, Profile } from '../hooks/effort'
import type { Answers } from '../hooks/jev'

const point = (difficulty: number, duration: number, scope: number, task_type = 'implement'): Distributions => distributions({
  difficulty: { probabilities: { [difficulty]: 1 } }, duration: { probabilities: { [duration]: 1 } }, scope: { probabilities: { [scope]: 1 } }, task_type: { probabilities: { [task_type]: 1 } },
})

test('one profile table reaches all six profiles regardless of role', () => {
  const reached = new Set<string>()
  for (let d = 0; d <= 4; d++) for (let t = 0; t <= 3; t++) for (let s = 0; s <= 3; s++) reached.add(choose(point(d, t, s)).profile.id)
  expect([...reached].sort()).toEqual(PROFILES.map(p => p.id).sort())
  expect(choose(point(0, 0, 0)).profile.id).toBe('luna-low')
  expect(choose(point(3, 1, 2)).profile.id).toBe('sol-high')
  expect(choose(point(4, 3, 3)).profile.id).toBe('sol-xhigh')
})

test('penalty integrates distribution tails and rounds each dimension and total to four places', () => {
  const profile = { point: { difficulty: 2, duration: 1, scope: 1 }, affinity: {} }
  const dist = { ...point(0, 0, 0), difficulty: { '0': 0.5, '4': 0.5 }, scope: { '0': 0.5, '3': 0.5 } }
  expect(penalty(profile, dist)).toBe(5.1875)
  expect(penalty(profile, dist)).not.toBe(penalty(profile, { ...dist, difficulty: { '2': 1 }, scope: { '1.5': 1 } }))
  const fractional = { ...point(0, 0, 0), difficulty: { '0': 1 / 3, '4': 2 / 3 }, duration: { '0': 1 / 3, '3': 2 / 3 }, scope: { '0': 1 / 3, '3': 2 / 3 } }
  // D=4.25, duration=4.0833, scope=2.0417: round dimensions before adding.
  expect(penalty(profile, fractional)).toBe(10.375)
  const tail = { ...point(0, 0, 0), difficulty: { '0': 0.25, '4': 0.75 } }
  expect(choose(tail).profile.id).toBe('sol-high')
})

test('choice penalty uses exact affinity then wildcard then default one', () => {
  const dist = point(0, 0, 0, 'docs')
  const base = { point: { difficulty: 0, duration: 0, scope: 0 } }
  expect(penalty({ ...base, affinity: { docs: 0.9, '*': 0.8 } }, dist)).toBe(0.025)
  expect(penalty({ ...base, affinity: { '*': 0.8 } }, dist)).toBe(0.05)
  expect(penalty({ ...base, affinity: {} }, dist)).toBe(0)
  expect(penalty({ ...base, affinity: { docs: 0 } }, dist)).toBe(0.25)
})

test('equal penalties prefer rank then original order', () => {
  const base = PROFILES[0]!
  const profiles: Profile[] = [{ ...base, id: 'first', rank: 9 }, { ...base, id: 'second', rank: 1 }, { ...base, id: 'third', rank: 1 }]
  expect(choose(point(2, 1, 1), profiles).profile.id).toBe('second')
  expect(choose(point(2, 1, 1), profiles.reverse()).profile.id).toBe('third')
})

test('four questions carry score criteria and a choice criteria map', () => {
  expect(Object.keys(QUESTIONS)).toEqual(['difficulty', 'duration', 'scope', 'task_type'])
  expect([QUESTIONS.difficulty.criteria.length, QUESTIONS.duration.criteria.length, QUESTIONS.scope.criteria.length]).toEqual([5, 4, 4])
  expect(QUESTIONS.task_type.type).toBe('choice')
  expect(Object.keys(QUESTIONS.task_type.criteria)).toEqual([...TASK_TYPES])
  expect(QUESTIONS.task_type).not.toHaveProperty('options')
})

test('probabilities normalize omitted entries and absent choice uses a uniform prior', () => {
  const answers = { difficulty: { probabilities: { '0': 0.2, '1': 0.2 } }, duration: { probabilities: { '1': 1 } }, scope: { probabilities: { '2': 1 } } }
  expect(distributions(answers).difficulty).toEqual({ '0': 0.5, '1': 0.5, '2': 0, '3': 0, '4': 0 })
  for (const p of Object.values(distributions(answers).task_type)) expect(Math.abs(p - 1 / 7) < 1e-12).toBe(true)
  for (const probs of [undefined, [], {}, { '0': 0 }, { '0': -1 }, { '0': '1' }, { '0': true }, { '0': NaN }, { '0': Infinity }, { '0': 2 }, { '4': 1 }, { '0.5': 1 }, { secret: 1 }]) {
    expect(() => distributions({ ...answers, duration: { probabilities: probs } } as Answers)).toThrow('probabilities')
  }
  for (const choice of [undefined, {}, { choice: 'docs', confidence: 1 }, { probabilities: {} }, { probabilities: { docs: 2 } }, { probabilities: { secret: 1 } }]) {
    expect(() => distributions({ ...answers, task_type: choice } as Answers)).toThrow('probabilities')
  }
  expect(() => distributions({ difficulty: answers.difficulty })).toThrow('probabilities')
  expect(distributions({}, { difficulty: 3, duration: 0, scope: 2, task_type: 'test' })).toEqual(point(3, 0, 2, 'test'))
})

test('directives respect escapes quotes inline code and matching fences without rebuilding the task', () => {
  const keep = String.raw`literal \@someone \!unknown person@example.com "@unknown !wrong=9" '@missing' ` + '`@code !long` ``@ticks``';
  const fenced = '\n````ts\n@inside !broken\n```\n@still-inside\n````\n~~~\n@tilde\n~~~\n'
  const task = keep + fenced + 'Do  @sol-high\t!hard !difficulty=3 !quick !scope=2 !task_type=docs  work'
  const parsed = parsePins(task, { model: 'gpt-6.1-sol', effort: 'high' })
  expect(parsed.task).toBe(keep + fenced + 'Do  \t      work')
  expect(parsed.pins).toEqual({ model: 'gpt-6.1-sol', effort: 'high', profileId: 'sol-high', dimensions: { difficulty: 3, duration: 0, scope: 2, task_type: 'docs' } })
  expect(parsePins("Don't skip !long this").pins.dimensions.duration).toBe(3)
})

test('unknown profiles invalid pins and contradictions use one fixed error without echoing text', () => {
  for (const task of ['@secret', '@sol-high,', '!secret=foo', '!difficulty=1.5', '!difficulty=5', '!duration=4', '!scope=-1', '!task_type=code', '!quick !long', '@sol-high @luna-low', '!hard !difficulty=4']) {
    expect(() => parsePins('Task ' + task)).toThrow(INVALID_PINS)
  }
  for (const fields of [{ model: 'secret' }, { effort: 'max' }, { model: 'gpt-6-luna' }, { effort: 'low' }]) expect(() => parsePins('Task @sol-high', fields)).toThrow(INVALID_PINS)
  expect(parsePins('@luna-low !quick').task.trim()).toBe('')
  expect(parsePins('Task @sol-high @sol-high').pins.profileId).toBe('sol-high')
})
