import { expect, test } from 'claude-code/testing'
import { assessProfile, choose, distributions, INVALID_PINS, parsePins, penalty, PROFILES, QUESTIONS, TASK_TYPES } from '../hooks/effort'
import type { Distributions, Profile } from '../hooks/effort'
import type { Answers } from '../hooks/jev'
import { createBreaker, createGate } from '../hooks/jev'
import { ports } from './host'
import { ROLES, SPECS } from '../hooks/roles'

const point = (difficulty: number, duration: number, scope: number, task_type = 'implement'): Distributions => distributions({
  difficulty: { probabilities: { [difficulty]: 1 } }, duration: { probabilities: { [duration]: 1 } }, scope: { probabilities: { [scope]: 1 } }, task_type: { probabilities: { [task_type]: 1 } },
})

test('one profile table reaches all six profiles regardless of role', () => {
  const reached = new Set<string>()
  for (let d = 0; d <= 4; d++) for (let t = 0; t <= 3; t++) for (let s = 0; s <= 3; s++) reached.add(choose(point(d, t, s)).profile.id)
  expect([...reached].sort()).toEqual(PROFILES.map(p => p.id).sort())
  expect(choose(point(0, 0, 0)).profile.id).toBe('haiku-low')
  expect(choose(point(3, 1, 2)).profile.id).toBe('sonnet-medium')
  expect(choose(point(3, 2, 3)).profile.id).toBe('sonnet-high')
  expect(choose(point(4, 3, 3)).profile.id).toBe('opus-high')
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
  expect(choose(tail).profile.id).toBe('opus-high')
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
  const task = keep + fenced + 'Do  @sonnet-high\t!hard !difficulty=3 !quick !scope=2 !task_type=docs  work'
  const parsed = parsePins(task, { model: 'sonnet', effort: 'high' })
  expect(parsed.task).toBe(keep + fenced + 'Do  \t      work')
  expect(parsed.pins).toEqual({ model: 'sonnet', effort: 'high', profileId: 'sonnet-high', dimensions: { difficulty: 3, duration: 0, scope: 2, task_type: 'docs' } })
  expect(parsePins("Don't skip !long this").pins.dimensions.duration).toBe(3)
})

test('unknown profiles invalid pins and contradictions use one fixed error without echoing text', () => {
  for (const task of ['@secret', '@sonnet-high,', '!secret=foo', '!difficulty=1.5', '!difficulty=5', '!duration=4', '!scope=-1', '!task_type=code', '!quick !long', '@sonnet-high @haiku-low', '!hard !difficulty=4']) {
    expect(() => parsePins('Task ' + task)).toThrow(INVALID_PINS)
  }
  for (const fields of [{ model: 'secret' }, { effort: 'max' }, { model: 'haiku' }, { effort: 'low' }]) expect(() => parsePins('Task @sonnet-high', fields)).toThrow(INVALID_PINS)
  expect(parsePins('@haiku-low !quick').task.trim()).toBe('')
  expect(parsePins('Task @sonnet-high @sonnet-high').pins.profileId).toBe('sonnet-high')
})

test('explicit pairs and profiles skip key settings and assessment while partial dimensions ask only the rest', async () => {
  const h = ports(); h.io.key = 'test-key'
  for (const role of ROLES) for (const model of ['haiku', 'sonnet', 'opus']) for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const choice = await assessProfile(h.io, { role, task: 'Task', home: h.io.home, root: h.io.root, key: h.io.key, pins: parsePins('Task', { model, effort }).pins })
    expect(choice).toMatchObject({ model, effort, source: 'pinned', jevAsked: false, dimensionsUsed: false })
  }
  for (const profile of PROFILES) {
    const choice = await assessProfile(h.io, { role: 'analyst', task: 'Task', home: h.io.home, root: h.io.root, key: h.io.key, pins: parsePins(`Task @${profile.id}`).pins })
    expect(choice.profileId).toBe(profile.id)
  }
  expect(h.requests).toHaveLength(0); expect(h.settingsReads).toHaveLength(0)
  const choice = await assessProfile(h.io, { role: 'analyst', task: 'Task', home: h.io.home, root: h.io.root, key: h.io.key, pins: parsePins('Task !difficulty=3 !task_type=docs').pins })
  expect(choice.source).toBe('jev'); expect(choice.dimensionsUsed).toBe(true)
  expect(Object.keys(JSON.parse(h.requests[0]!.body).questions)).toEqual(['duration', 'scope'])
  expect(choice.expected?.difficulty).toBe(3)
})
test('every assessment failure keeps the exact role fallback and logging failure changes nothing', async () => {
  for (const role of ROLES) for (const reason of ['no-key', 'bad-key', 'unreadable-settings', 'repo-declared-key', 'http', 'malformed', 'breaker', 'busy', 'timeout', 'network'] as const) {
    const h = ports(); let key: string | undefined = 'test-key'
    if (reason === 'no-key') key = undefined
    if (reason === 'bad-key') key = 'has space'
    if (reason === 'unreadable-settings') h.faults.settings = true
    if (reason === 'repo-declared-key') h.io.settings = async () => ({ env: { JEV_API_KEY: key } })
    if (reason === 'http') h.faults.http = 401
    if (reason === 'malformed') h.io.jev.fetch = async () => ({ status: 200, text: '{}' })
    if (reason === 'network') h.io.jev.fetch = async () => { throw new Error('private failure') }
    if (reason === 'breaker') { h.io.breaker = createBreaker(() => 0); h.io.breaker.failure(); h.io.breaker.failure(); h.io.breaker.failure() }
    if (reason === 'busy') { h.io.gate = createGate(); for (let n = 0; n < 4; n++) h.io.gate.acquire() }
    if (reason === 'timeout') {
      h.io.jev.fetch = async () => new Promise(() => {})
      h.io.jev.timer = (ms, fn) => { let cancelled = false; if (ms === 3000) void Promise.resolve().then(() => { if (!cancelled) fn() }); return () => { cancelled = true } }
    }
    h.io.log = () => { throw new Error('logging failed') }
    const choice = await assessProfile(h.io, { role, task: 'Task', home: h.io.home, root: h.io.root, key, pins: parsePins('Task !hard').pins })
    expect(choice).toMatchObject({ model: SPECS[role].model, effort: SPECS[role].effort, source: 'default', jevReason: reason, dimensionsUsed: false, expected: null })
  }
})
test('assessment masks the whole task before clipping and sends only cleaned task state', async () => {
  const h = ports(), key = 'private-test-key'
  const task = 'Review /home/u/private/project/file.ts ' + key.repeat(700) + ' tail'
  const choice = await assessProfile(h.io, { role: 'reviewer', task, home: h.io.home, root: h.io.root, key, pins: parsePins('Task').pins })
  expect(choice.source).toBe('jev')
  const request = h.requests[0]!, state = JSON.parse(request.body).state as string
  expect(state.length).toBeLessThanOrEqual(4000); expect(state).not.toContain(key); expect(state).not.toContain('/home/u/private')
  expect(request.headers.Authorization).toBe(`Bearer ${key}`)
})
