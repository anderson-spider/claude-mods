import { expect, test } from 'claude-code/testing'
import { assessRoute, distributions, INVALID_PINS, levelOf, parsePins, QUESTIONS } from '../hooks/effort'
import type { Answers } from '../hooks/jev'
import { createBreaker, createGate } from '../hooks/jev'
import { ports } from './host'
import { EFFORTS, MODELS, ROLES, SPECS } from '../hooks/roles'

test('two questions carry the difficulty and duration criteria and nothing else', () => {
  expect(Object.keys(QUESTIONS)).toEqual(['difficulty', 'duration'])
  expect([QUESTIONS.difficulty.criteria.length, QUESTIONS.duration.criteria.length]).toEqual([5, 4])
  expect(QUESTIONS.difficulty.instructions).toBe('How hard is this task for a capable coding agent?')
  expect(QUESTIONS.duration.instructions).toBe('How long will a coding agent need to finish this task?')
})

test('the level minimizes expected penalty with under-capacity weighted twice and ties going lower', () => {
  expect(levelOf({ '0': 1, '1': 0, '2': 0, '3': 0, '4': 0 })).toBe(0)
  expect(levelOf({ '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 })).toBe(4)
  // Even odds between 0 and 1: missing capacity costs twice as much, so the higher level wins.
  expect(levelOf({ '0': 0.5, '1': 0.5 })).toBe(1)
  // Exactly two thirds on the lower level: both levels cost the same and the lower one wins.
  expect(levelOf({ '0': 2 / 3, '1': 1 / 3 })).toBe(0)
  expect(levelOf({ '0': 0.6, '1': 0.4 })).toBe(1)
  expect(levelOf({ '0': 0.7, '1': 0.3 })).toBe(0)
  // A tail that matters: a quarter of the weight on level 4 pulls past the middle.
  expect(levelOf({ '0': 0.25, '2': 0.5, '4': 0.25 })).toBe(2)
  expect(levelOf({ '0': 0.25, '2': 0.25, '4': 0.5 })).toBe(4)
  // Ties among distant levels also go to the lowest; one more third on the high level breaks it.
  expect(levelOf({ '0': 2 / 3, '3': 1 / 3 })).toBe(0)
  expect(levelOf({ '0': 1 / 3, '3': 2 / 3 })).toBe(3)
})

test('probabilities normalize omitted entries and invalid distributions fail closed', () => {
  const answers = { difficulty: { probabilities: { '0': 0.2, '1': 0.2 } }, duration: { probabilities: { '1': 1 } } }
  expect(distributions(answers).difficulty).toEqual({ '0': 0.5, '1': 0.5, '2': 0, '3': 0, '4': 0 })
  for (const probs of [undefined, [], {}, { '0': 0 }, { '0': -1 }, { '0': '1' }, { '0': true }, { '0': NaN }, { '0': Infinity }, { '0': 2 }, { '4': 1 }, { '0.5': 1 }, { secret: 1 }]) {
    expect(() => distributions({ ...answers, duration: { probabilities: probs } } as Answers)).toThrow('probabilities')
  }
  expect(() => distributions({ difficulty: answers.difficulty })).toThrow('probabilities')
  expect(distributions({}, { difficulty: 3, duration: 0 })).toEqual({ difficulty: { '0': 0, '1': 0, '2': 0, '3': 1, '4': 0 }, duration: { '0': 1, '1': 0, '2': 0, '3': 0 } })
})

test('directives respect escapes quotes inline code and matching fences without rebuilding the task', () => {
  const keep = String.raw`literal \!unknown person@example.com "!wrong=9" '!missing' ` + '`!long` ``!hard``'
  const fenced = '\n````ts\n!inside !broken\n```\n!still-inside\n````\n~~~\n!tilde\n~~~\n'
  const task = keep + fenced + 'Do  @sonnet-high\t!hard !difficulty=3 !quick  work'
  const parsed = parsePins(task, { model: 'sonnet', effort: 'high' })
  expect(parsed.task).toBe(keep + fenced + 'Do  @sonnet-high\t    work')
  expect(parsed.pins).toEqual({ model: 'sonnet', effort: 'high', dimensions: { difficulty: 3, duration: 0 } })
  expect(parsePins("Don't skip !long this").pins.dimensions.duration).toBe(3)
})

test('at-sign words are plain task text, never directives or refusals', () => {
  for (const word of ['@sonnet-high', '@haiku-low', '@opus-high', '@secret', '@anyone,']) {
    const parsed = parsePins(`Task ${word} here`)
    expect(parsed.task).toBe(`Task ${word} here`)
    expect(parsed.pins).toEqual({ dimensions: {} })
  }
})

test('invalid pins and directives use one fixed error without echoing text', () => {
  for (const task of ['!secret=foo', '!difficulty=1.5', '!difficulty=5', '!duration=4', '!difficulty=-1', '!scope=2', '!task_type=docs', '!quick !long', '!hard !difficulty=4']) {
    expect(() => parsePins('Task ' + task)).toThrow(INVALID_PINS)
  }
  for (const fields of [{ model: 'secret' }, { model: 'gpt' }, { effort: 'ultra' }, { effort: 'Max' }, { model: 1 }]) expect(() => parsePins('Task', fields)).toThrow(INVALID_PINS)
  expect(parsePins('!hard !quick').task.trim()).toBe('')
  expect(parsePins('Task !hard !difficulty=3').pins.dimensions).toEqual({ difficulty: 3 })
  for (const model of MODELS) for (const effort of EFFORTS) expect(parsePins('Task', { model, effort }).pins).toEqual({ model, effort, dimensions: {} })
})

const ask = (h: ReturnType<typeof ports>, pins: ReturnType<typeof parsePins>['pins'], role: (typeof ROLES)[number] = 'analyst', key: string | null = 'test-key') =>
  assessRoute(h.io, { role, task: 'Task', home: h.io.home, root: h.io.root, key: key ?? undefined, pins })

test('Jev levels select the pair from the table, grouping duration after the level is chosen', async () => {
  const cases: [number, number, string][] = [[0, 0, 'haiku/low'], [0, 1, 'haiku/low'], [0, 2, 'haiku/low'], [0, 3, 'haiku/medium'], [1, 0, 'sonnet/low'], [2, 3, 'sonnet/high'], [3, 1, 'opus/low'], [4, 1, 'opus/high'], [4, 2, 'fable/high'], [4, 3, 'fable/high']]
  for (const [difficulty, duration, pair] of cases) {
    const h = ports(); h.answers.difficulty = { probabilities: { [difficulty]: 1 } }; h.answers.duration = { probabilities: { [duration]: 1 } }
    const choice = await ask(h, parsePins('Task').pins)
    expect(`${choice.model}/${choice.effort}`).toBe(pair)
    expect(choice).toMatchObject({ source: 'jev', jevAsked: true, levels: { difficulty, duration } })
    expect(Object.keys(JSON.parse(h.requests[0]!.body).questions)).toEqual(['difficulty', 'duration'])
  }
  const h = ports(); h.answers.difficulty = { probabilities: { '1': 0.5, '2': 0.5 } }; h.answers.duration = { probabilities: { '1': 0.5, '2': 0.5 } }
  expect(await ask(h, parsePins('Task').pins)).toMatchObject({ model: 'sonnet', effort: 'high', levels: { difficulty: 2, duration: 2 } })
})

test('explicit pairs skip key settings and assessment', async () => {
  const h = ports()
  for (const role of ROLES) for (const model of MODELS) for (const effort of EFFORTS) {
    expect(await ask(h, parsePins('Task', { model, effort }).pins, role)).toMatchObject({ model, effort, source: 'pinned', jevAsked: false, levels: null })
  }
  expect(h.requests).toHaveLength(0); expect(h.settingsReads).toHaveLength(0)
})

test('a pinned lever skips Jev for that lever while Jev still decides the other', async () => {
  const h = ports(); h.answers.difficulty = { probabilities: { '3': 1 } }; h.answers.duration = { probabilities: { '3': 1 } }
  expect(await ask(h, parsePins('Task', { model: 'haiku' }).pins)).toMatchObject({ model: 'haiku', effort: 'high', source: 'jev' })
  expect(await ask(h, parsePins('Task', { effort: 'max' }).pins)).toMatchObject({ model: 'opus', effort: 'max', source: 'jev' })
  expect(h.requests).toHaveLength(2)
  const off = ports()
  expect(await ask(off, parsePins('Task', { effort: 'xhigh' }).pins, 'reviewer', null)).toMatchObject({ model: 'opus', effort: 'xhigh', source: 'default', jevReason: 'no-key' })
})

test('dimension directives ask only the rest and both together decide locally', async () => {
  const h = ports(); h.answers.duration = { probabilities: { '2': 1 } }
  const partial = await ask(h, parsePins('Task !hard').pins)
  expect(Object.keys(JSON.parse(h.requests[0]!.body).questions)).toEqual(['duration'])
  expect(partial).toMatchObject({ model: 'opus', effort: 'medium', source: 'jev', levels: { difficulty: 3, duration: 2 } })
  const local = ports()
  expect(await ask(local, parsePins('Task !difficulty=4 !duration=3').pins, 'analyst', null)).toMatchObject({ model: 'fable', effort: 'high', source: 'override', jevAsked: false })
  expect(local.requests).toHaveLength(0); expect(local.settingsReads).toHaveLength(0)
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
    const choice = await ask(h, parsePins('Task !hard').pins, role, key ?? null)
    expect(choice).toMatchObject({ model: SPECS[role].model, effort: SPECS[role].effort, source: 'default', jevReason: reason, levels: null, jevAsked: reason === 'http' || reason === 'malformed' || reason === 'network' || reason === 'timeout' })
  }
})
test('assessment masks the whole task before clipping and sends only cleaned task state', async () => {
  const h = ports(), key = 'private-test-key'
  const task = 'Review /home/u/private/project/file.ts ' + key.repeat(700) + ' tail'
  const choice = await assessRoute(h.io, { role: 'reviewer', task, home: h.io.home, root: h.io.root, key, pins: parsePins('Task').pins })
  expect(choice.source).toBe('jev')
  const request = h.requests[0]!, state = JSON.parse(request.body).state as string
  expect(state.length).toBeLessThanOrEqual(4000); expect(state).not.toContain(key); expect(state).not.toContain('/home/u/private')
  expect(request.headers.Authorization).toBe(`Bearer ${key}`)
})
