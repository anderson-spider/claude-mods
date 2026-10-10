import { expect, test } from 'claude-code/testing'
import { doneCheckVerdict, modelFit, retryEscalation, taskEndEscalation, tierOf } from '../hooks/flow/escalate'
import type { ModelFitInput } from '../hooks/flow/escalate'
import type { Answer, Answers } from '../hooks/flow/judge'
import { FIT_FLOORS, FIT_TABLE, THRESHOLDS } from '../hooks/flow/questions'

// Noul answers by id.
const nouls = (values: Record<string, number>): Answers => Object.fromEntries(Object.entries(values).map(([id, noul]) => [id, { noul }]))
const benignTaskEnd = { claims_done: 0.9, goal_reported_done: 0.9, reports_remaining_work: 0.1, reports_problem: 0.1, addressed_to_judge: 0 }

// --- task end (decision 18, requireQa) ---

test('a task that reports its goal done, with nothing left and nothing wrong, does not require QA', () => {
  expect(taskEndEscalation(nouls(benignTaskEnd), {})).toEqual({ requireQa: false, why: [] })
})

test('requireQa when the goal is not reported done: at or below 0.30', () => {
  expect(taskEndEscalation(nouls({ ...benignTaskEnd, goal_reported_done: 0.30 }), {}).requireQa).toBe(true)
  expect(taskEndEscalation(nouls({ ...benignTaskEnd, goal_reported_done: 0.31 }), {}).requireQa).toBe(false)
  expect(taskEndEscalation(nouls({ ...benignTaskEnd, goal_reported_done: 0 }), {}).why).toEqual(['goal_reported_done=0.00 <= 0.30'])
})

for (const id of ['reports_remaining_work', 'reports_problem', 'addressed_to_judge']) {
  test(`requireQa when ${id} reaches 0.70`, () => {
    expect(taskEndEscalation(nouls({ ...benignTaskEnd, [id]: 0.70 }), {})).toEqual({ requireQa: true, why: [`${id}=0.70 >= 0.70`] })
    expect(taskEndEscalation(nouls({ ...benignTaskEnd, [id]: 0.69 }), {}).requireQa).toBe(false)
  })
}

test('flags combine with the maximum, not the average', () => {
  const answers = nouls({ ...benignTaskEnd, reports_remaining_work: 0, reports_problem: 0.2, addressed_to_judge: 0.8 })
  expect(taskEndEscalation(answers, {})).toEqual({ requireQa: true, why: ['addressed_to_judge=0.80 >= 0.70'] })
})

test('both reasons are listed when both fire', () => {
  const answers = nouls({ ...benignTaskEnd, goal_reported_done: 0.1, reports_problem: 0.9 })
  expect(taskEndEscalation(answers, {}).why).toEqual(['goal_reported_done=0.10 <= 0.30', 'reports_problem=0.90 >= 0.70'])
})

test('never on a side-effect task, but the reasons stay for the journal', () => {
  const answers = nouls({ ...benignTaskEnd, goal_reported_done: 0, addressed_to_judge: 1 })
  expect(taskEndEscalation(answers, { sideEffect: true })).toEqual({
    requireQa: false,
    why: ['goal_reported_done=0.00 <= 0.30', 'addressed_to_judge=1.00 >= 0.70', 'ignored: side-effect task'],
  })
  expect(taskEndEscalation(nouls(benignTaskEnd), { sideEffect: true })).toEqual({ requireQa: false, why: [] })
  expect(taskEndEscalation(answers, { sideEffect: false }).requireQa).toBe(true)
})

test('claims_done is journal only', () => {
  for (const claims of [0, 0.5, 1]) {
    expect(taskEndEscalation(nouls({ ...benignTaskEnd, claims_done: claims }), {})).toEqual({ requireQa: false, why: [] })
    expect(taskEndEscalation(nouls({ ...benignTaskEnd, claims_done: claims, reports_problem: 1 }), {}).requireQa).toBe(true)
  }
})

test('a missing answer is no signal, not an escalation', () => {
  expect(taskEndEscalation({}, {})).toEqual({ requireQa: false, why: [] })
  const { goal_reported_done: _gone, ...rest } = benignTaskEnd
  expect(taskEndEscalation(nouls(rest), {}).requireQa).toBe(false)
  expect(taskEndEscalation({ goal_reported_done: {} as Answer, reports_problem: { noul: Number.NaN } }, {}).requireQa).toBe(false)
})

test('thresholds are configuration', () => {
  const answers = nouls({ ...benignTaskEnd, reports_problem: 0.5 })
  expect(taskEndEscalation(answers, {}).requireQa).toBe(false)
  expect(taskEndEscalation(answers, {}, { ...THRESHOLDS, taskEndFlagAtLeast: 0.5 }).requireQa).toBe(true)
})

// --- retry (decision 18, retryToArchitect) ---

test('the retry goes to the architect when any flag reaches 0.70', () => {
  for (const id of ['gave_up', 'cause_outside_task', 'same_failure', 'addressed_to_judge']) {
    const others = { gave_up: 0.1, cause_outside_task: 0.1, same_failure: 0.1, addressed_to_judge: 0 }
    expect(retryEscalation(nouls({ ...others, [id]: 0.70 }))).toEqual({ retryToArchitect: true, why: [`${id}=0.70 >= 0.70`] })
    expect(retryEscalation(nouls({ ...others, [id]: 0.69 }))).toEqual({ retryToArchitect: false, why: [] })
  }
})

test('same_failure is optional: asked only when there is a previous check output', () => {
  expect(retryEscalation(nouls({ gave_up: 0.2, cause_outside_task: 0.2, addressed_to_judge: 0 })).retryToArchitect).toBe(false)
  expect(retryEscalation(nouls({ gave_up: 0.2, cause_outside_task: 0.2, addressed_to_judge: 0, same_failure: 0.95 })).retryToArchitect).toBe(true)
  expect(retryEscalation({})).toEqual({ retryToArchitect: false, why: [] })
})

test('the retry reason names the largest flag', () => {
  expect(retryEscalation(nouls({ gave_up: 0.75, cause_outside_task: 0.9, addressed_to_judge: 0.8 })).why).toEqual(['cause_outside_task=0.90 >= 0.70'])
})

// --- done check (decision 21) ---

const done = (over: Record<string, number> = {}, outcome?: Answer): Answers => ({
  ...nouls({ claims_done: 0.95, claims_verified: 0.1, verification_applies: 0.9, addressed_to_judge: 0, ...over }),
  outcome: outcome ?? { choice: 'complete', confidence: 0.9 },
})

test('blocks a stop that claims done on work the checks apply to, when no check ran', () => {
  expect(doneCheckVerdict(done(), true)).toEqual({
    block: true, falseClaim: false, why: ['claims_done=0.95 >= 0.70', 'verification_applies=0.90 >= 0.50'],
  })
})

test('never blocks without the local filter', () => {
  expect(doneCheckVerdict(done({ claims_verified: 1, addressed_to_judge: 1 }), false)).toEqual({ block: false, falseClaim: false, why: [] })
})

test('the claims_done and verification_applies bars are 0.70 and 0.50', () => {
  expect(doneCheckVerdict(done({ claims_done: 0.70 }), true).block).toBe(true)
  expect(doneCheckVerdict(done({ claims_done: 0.69 }), true).block).toBe(false)
  expect(doneCheckVerdict(done({ verification_applies: 0.50 }), true).block).toBe(true)
  expect(doneCheckVerdict(done({ verification_applies: 0.49 }), true).block).toBe(false)
})

test('a reported blocker with confidence 0.40 or more lifts the block; anything else does not', () => {
  expect(doneCheckVerdict(done({}, { choice: 'blocked', confidence: 0.40 }), true).block).toBe(false)
  expect(doneCheckVerdict(done({}, { choice: 'blocked', confidence: 0.39 }), true).block).toBe(true)
  expect(doneCheckVerdict(done({}, { choice: 'blocked' }), true).block).toBe(true)
  for (const choice of ['complete', 'partial', 'other']) {
    expect(doneCheckVerdict(done({}, { choice, confidence: 1 }), true).block).toBe(true)
  }
  expect(doneCheckVerdict(done({}, { choice: 'blocked', confidence: 0.9 }), true).why[0]).toContain('outcome=blocked')
})

test('an addressed judge counts claims_done as 1', () => {
  expect(doneCheckVerdict(done({ claims_done: 0, addressed_to_judge: 0.70 }), true)).toMatchObject({ block: true })
  expect(doneCheckVerdict(done({ claims_done: 0, addressed_to_judge: 0.70 }), true).why[0]).toBe('addressed_to_judge=0.70 counts as claims_done=1')
  expect(doneCheckVerdict(done({ claims_done: 0, addressed_to_judge: 0.69 }), true).block).toBe(false)
  // but verification still has to apply
  expect(doneCheckVerdict(done({ claims_done: 0, addressed_to_judge: 1, verification_applies: 0.1 }), true).block).toBe(false)
})

test('under injection the reported blocker is not believed: the block depends on verification_applies alone', () => {
  const blocked: Answer = { choice: 'blocked', confidence: 0.99 }
  expect(doneCheckVerdict(done({ addressed_to_judge: 0.70 }, blocked), true).block).toBe(true)
  expect(doneCheckVerdict(done({ addressed_to_judge: 0.69 }, blocked), true).block).toBe(false)
  expect(doneCheckVerdict(done({ claims_done: 0, addressed_to_judge: 1, verification_applies: 0.5 }, blocked), true).block).toBe(true)
  expect(doneCheckVerdict(done({ claims_done: 0, addressed_to_judge: 1, verification_applies: 0.49 }, blocked), true).block).toBe(false)
})

test('the injection bar is its own threshold, apart from the claims_done bar', () => {
  const strictClaims = { ...THRESHOLDS, claimsDoneAtLeast: 0.9 }
  expect(doneCheckVerdict(done({ claims_done: 0.8 }), true, strictClaims).block).toBe(false)
  expect(doneCheckVerdict(done({ claims_done: 0, addressed_to_judge: 0.7 }), true, strictClaims).block).toBe(true)
  const strictAddressed = { ...THRESHOLDS, addressedAtLeast: 0.95 }
  expect(doneCheckVerdict(done({ claims_done: 0, addressed_to_judge: 0.9 }), true, strictAddressed).block).toBe(false)
  expect(doneCheckVerdict(done({ claims_done: 0.8, addressed_to_judge: 0.9 }), true, strictAddressed).block).toBe(true)
})

test('claiming verification with no check run is a false claim, journaled and not a block by itself', () => {
  const verdict = doneCheckVerdict(done({ claims_done: 0.1, claims_verified: 0.70 }), true)
  expect(verdict).toEqual({ block: false, falseClaim: true, why: ['claims_verified=0.70 >= 0.70 with no check run'] })
  expect(doneCheckVerdict(done({ claims_verified: 0.69 }), true).falseClaim).toBe(false)
  expect(doneCheckVerdict(done({ claims_verified: 0.9 }), true)).toMatchObject({ block: true, falseClaim: true })
})

test('missing answers never block (fail open)', () => {
  expect(doneCheckVerdict({}, true)).toEqual({ block: false, falseClaim: false, why: [] })
  const { verification_applies: _gone, ...rest } = done()
  expect(doneCheckVerdict(rest, true).block).toBe(false)
  const { claims_done: _gone2, ...rest2 } = done()
  expect(doneCheckVerdict(rest2, true).block).toBe(false)
})

// --- model fit (decision 20) ---

const fitAnswers = (over: { score?: number; confidence?: number; underspecified?: number; sensitive?: number; addressed?: number } = {}): Answers => ({
  difficulty: { score: over.score ?? 0.4, confidence: over.confidence ?? 0.9 },
  ...nouls({ underspecified: over.underspecified ?? 0.1, sensitive_area: over.sensitive ?? 0.05, addressed_to_judge: over.addressed ?? 0 }),
})
const fitInput = (over: Partial<ModelFitInput> = {}): ModelFitInput =>
  ({ role: 'developer', floor: 'haiku', default: 'sonnet', table: FIT_TABLE, floorsPassed: true, calibrated: true, ...over })

test('a confident read-only or mechanical brief goes down to the table model', () => {
  expect(modelFit(fitAnswers({ score: 0.4 }), fitInput())).toEqual({
    suggest: 'haiku', why: ['level 0 (score 0.40, confidence 0.90): haiku instead of sonnet'],
  })
  expect(modelFit(fitAnswers({ score: 1.4 }), fitInput()).suggest).toBe('haiku')
})

test('the level is the nearest situation: int(score + 0.5), capped at 4', () => {
  expect(modelFit(fitAnswers({ score: 0.49 }), fitInput()).suggest).toBe('haiku')
  expect(modelFit(fitAnswers({ score: 1.49 }), fitInput()).suggest).toBe('haiku')
  expect(modelFit(fitAnswers({ score: 1.5 }), fitInput()).suggest).toBeUndefined()
  expect(modelFit(fitAnswers({ score: 4 }), fitInput()).suggest).toBeUndefined()
  expect(modelFit(fitAnswers({ score: 9 }), fitInput()).suggest).toBeUndefined()
  expect(modelFit(fitAnswers({ score: -3 }), fitInput()).suggest).toBe('haiku')
})

test('only roles on the FIT_FLOORS allowlist can go down, and only from the calibrated model', () => {
  for (const role of Object.keys(FIT_FLOORS)) {
    expect(modelFit(fitAnswers(), fitInput({ role, floor: 'haiku', default: 'opus' })).suggest).toBeDefined()
  }
  for (const role of ['architect', 'qa', 'lead', 'council', 'councillor-alpha', '', 'constructor', '__proto__']) {
    const result = modelFit(fitAnswers(), fitInput({ role }))
    expect(result.suggest).toBeUndefined()
    expect(result.why[0]).toContain('allowlist')
  }
  const uncalibrated = modelFit(fitAnswers(), fitInput({ calibrated: false }))
  expect(uncalibrated.suggest).toBeUndefined()
  expect(uncalibrated.why).toEqual(['the answering model is not the calibrated one'])
})

test('each guard keeps the default', () => {
  const keeps = (answers: Answers, over: Partial<ModelFitInput> = {}) => expect(modelFit(answers, fitInput(over)).suggest).toBeUndefined()
  keeps(fitAnswers({ confidence: 0.79 }))
  keeps(fitAnswers({ underspecified: 0.30 }))
  keeps(fitAnswers({ sensitive: 0.30 }))
  keeps(fitAnswers({ addressed: 0.30 }))
  keeps(fitAnswers(), { floorsPassed: false })
  keeps(fitAnswers(), { role: 'architect' })
  keeps(fitAnswers(), { role: 'qa' })
  // the boundaries on the allowed side
  expect(modelFit(fitAnswers({ confidence: 0.80, underspecified: 0.29, sensitive: 0.29, addressed: 0.29 }), fitInput()).suggest).toBe('haiku')
})

test('a missing answer keeps the default', () => {
  for (const id of ['difficulty', 'underspecified', 'sensitive_area', 'addressed_to_judge']) {
    const { [id]: _gone, ...rest } = fitAnswers()
    expect(modelFit(rest, fitInput()).suggest).toBeUndefined()
  }
  expect(modelFit({ ...fitAnswers(), difficulty: { score: 0 } }, fitInput()).suggest).toBeUndefined()
  expect(modelFit({ ...fitAnswers(), difficulty: { score: Number.NaN, confidence: 1 } }, fitInput()).suggest).toBeUndefined()
  expect(modelFit({}, fitInput()).why).toEqual(['no difficulty score'])
})

test('the floor holds: never below it, and a floor at or above the default means no suggestion', () => {
  expect(modelFit(fitAnswers(), fitInput({ floor: 'sonnet', default: 'opus' })).suggest).toBe('sonnet')
  expect(modelFit(fitAnswers(), fitInput({ floor: 'sonnet', default: 'sonnet' })).suggest).toBeUndefined()
  expect(modelFit(fitAnswers(), fitInput({ floor: 'opus', default: 'sonnet' })).suggest).toBeUndefined()
  expect(modelFit(fitAnswers(), fitInput({ floor: 'haiku', default: 'haiku' })).suggest).toBeUndefined()
})

test('the role\'s own floor holds when the caller passes a lower one', () => {
  // ux may not go below sonnet, whatever floor the caller says
  expect(FIT_FLOORS.ux).toBe('sonnet')
  expect(modelFit(fitAnswers(), fitInput({ role: 'ux', floor: 'haiku', default: 'opus' }))).toMatchObject({ suggest: 'sonnet' })
  expect(modelFit(fitAnswers(), fitInput({ role: 'ux', floor: 'haiku', default: 'sonnet' })).suggest).toBeUndefined()
  expect(modelFit(fitAnswers(), fitInput({ role: 'ux', floor: 'claude-haiku-4-5', default: 'claude-sonnet-4-6', table: ['claude-haiku-4-5'] })).suggest).toBeUndefined()
  // a caller floor above the role's floor still wins, and the suggestion keeps the higher one's spelling
  expect(modelFit(fitAnswers(), fitInput({ role: 'developer', floor: 'sonnet', default: 'opus', table: ['haiku'] })).suggest).toBe('sonnet')
  expect(modelFit(fitAnswers(), fitInput({ role: 'developer', floor: 'claude-sonnet-4-6', default: 'opus', table: ['haiku'] })).suggest).toBe('claude-sonnet-4-6')
  // an unknown floor on either side keeps the default
  expect(modelFit(fitAnswers(), fitInput({ role: 'developer', floor: 'nonsense', default: 'opus' })).suggest).toBeUndefined()
})

test('never above the default: a table entry at or above it keeps the default', () => {
  expect(modelFit(fitAnswers(), fitInput({ table: ['sonnet', 'sonnet', 'sonnet', 'sonnet', 'sonnet'] })).suggest).toBeUndefined()
  expect(modelFit(fitAnswers(), fitInput({ table: ['opus'] })).suggest).toBeUndefined()
  expect(modelFit(fitAnswers(), fitInput({ default: 'opus', table: ['sonnet'] })).suggest).toBe('sonnet')
})

test('a short table uses its last entry; an empty or unknown one keeps the default', () => {
  expect(modelFit(fitAnswers({ score: 1.2 }), fitInput({ table: ['haiku'] })).suggest).toBe('haiku')
  expect(modelFit(fitAnswers(), fitInput({ table: [] })).suggest).toBeUndefined()
  expect(modelFit(fitAnswers(), fitInput({ table: ['gpt-9'] })).suggest).toBeUndefined()
})

test('models without a known tier never take part', () => {
  for (const model of ['inherit', 'default', 'opusplan', 'fable', 'gpt-9', '']) {
    expect(modelFit(fitAnswers(), fitInput({ default: model })).suggest).toBeUndefined()
    expect(modelFit(fitAnswers(), fitInput({ floor: model })).suggest).toBeUndefined()
  }
})

test('model ids and bracket suffixes rank like their aliases, and the suggestion keeps the caller\'s spelling', () => {
  expect(tierOf('haiku')).toBe(1)
  expect(tierOf('sonnet[1m]')).toBe(2)
  expect(tierOf('claude-opus-4-7')).toBe(3)
  expect(tierOf('claude-haiku-4-5-20251001')).toBe(1)
  expect(tierOf('Sonnet')).toBe(2)
  // the name has to start with the tier (or `claude-<tier>`): a name that merely contains it is another model
  for (const model of [
    'opusplan', 'inherit', 'fable', 'claude-fable-1', 'sonnetx', 'xhaiku', 'my-sonnet-fork', 'gpt-sonnet-9', 'x-opus-1',
    'claude-3-5-haiku-20241022', 'anthropic.claude-sonnet-4-6', 'models/haiku', ' sonnet', '',
  ]) expect(tierOf(model)).toBeUndefined()
  expect(modelFit(fitAnswers(), fitInput({ floor: 'haiku', default: 'my-sonnet-fork', table: ['haiku'] })).suggest).toBeUndefined()
  expect(modelFit(fitAnswers(), fitInput({ floor: 'my-haiku-fork', default: 'opus', table: ['haiku'] })).suggest).toBeUndefined()
  const result = modelFit(fitAnswers(), fitInput({ floor: 'claude-haiku-4-5', default: 'claude-sonnet-4-6', table: ['claude-haiku-4-5'] }))
  expect(result.suggest).toBe('claude-haiku-4-5')
})

test('the shipped floors and table: no floor for the architect and QA, ux keeps sonnet', () => {
  expect(modelFit(fitAnswers(), fitInput({ role: 'ux', floor: FIT_FLOORS.ux!, default: 'sonnet' })).suggest).toBeUndefined()
  expect(modelFit(fitAnswers(), fitInput({ role: 'git', floor: FIT_FLOORS.git!, default: 'sonnet' })).suggest).toBe('haiku')
  expect(FIT_FLOORS.architect).toBeUndefined()
  expect(FIT_FLOORS.qa).toBeUndefined()
})

// --- properties: escalations never loosen ---

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const ROUNDS = 3000
// Values as the API returns them: rounded to two decimals, with the edges over-represented.
const value = (rand: () => number): number => {
  const r = rand()
  return r < 0.1 ? 0 : r < 0.2 ? 1 : r < 0.3 ? 0.3 : r < 0.4 ? 0.7 : Math.round(rand() * 100) / 100
}
const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!

test('property: raising any "wrong" flag or lowering goal_reported_done never removes requireQa', () => {
  const rand = prng(1)
  const ids = ['reports_remaining_work', 'reports_problem', 'addressed_to_judge'] as const
  for (let i = 0; i < ROUNDS; i++) {
    const base = { claims_done: value(rand), goal_reported_done: value(rand), reports_remaining_work: value(rand), reports_problem: value(rand), addressed_to_judge: value(rand) }
    const task = { sideEffect: rand() < 0.3 }
    const before = taskEndEscalation(nouls(base), task)
    const raised = { ...base }
    const id = pick(rand, ids)
    raised[id] = Math.max(raised[id], value(rand))
    raised.goal_reported_done = Math.min(raised.goal_reported_done, value(rand))
    const after = taskEndEscalation(nouls(raised), task)
    if (before.requireQa) expect(after.requireQa).toBe(true)
    // never for a side-effect task; claims_done never matters
    if (task.sideEffect) expect(after.requireQa).toBe(false)
    expect(taskEndEscalation(nouls({ ...base, claims_done: value(rand) }), task).requireQa).toBe(before.requireQa)
    // an escalation always says why
    expect(after.requireQa === false || after.why.length > 0).toBe(true)
  }
})

test('property: raising any retry flag never removes retryToArchitect', () => {
  const rand = prng(2)
  const ids = ['gave_up', 'cause_outside_task', 'same_failure', 'addressed_to_judge'] as const
  for (let i = 0; i < ROUNDS; i++) {
    const base: Record<string, number> = { gave_up: value(rand), cause_outside_task: value(rand), addressed_to_judge: value(rand) }
    if (rand() < 0.5) base.same_failure = value(rand)
    const before = retryEscalation(nouls(base))
    const raised = { ...base }
    const id = pick(rand, ids)
    raised[id] = Math.max(raised[id] ?? 0, value(rand))
    const after = retryEscalation(nouls(raised))
    if (before.retryToArchitect) expect(after.retryToArchitect).toBe(true)
    // it is exactly the max rule
    const max = Math.max(...Object.values(raised))
    expect(after.retryToArchitect).toBe(max >= 0.70)
  }
})

test('property: a higher addressed_to_judge, claims_done or verification_applies never lifts a block; claims_verified only adds false claims', () => {
  const rand = prng(3)
  const outcomes: Answer[] = [{ choice: 'complete', confidence: 0.9 }, { choice: 'partial', confidence: 0.5 }, { choice: 'blocked', confidence: 0.8 }, { choice: 'blocked', confidence: 0.1 }, { choice: 'other', confidence: 0 }]
  for (let i = 0; i < ROUNDS; i++) {
    const base = { claims_done: value(rand), claims_verified: value(rand), verification_applies: value(rand), addressed_to_judge: value(rand) }
    const outcome = pick(rand, outcomes)
    const needs = rand() < 0.7
    const answers = (v: typeof base): Answers => ({ ...nouls(v), outcome })
    const before = doneCheckVerdict(answers(base), needs)
    const raised = { ...base }
    for (const id of ['addressed_to_judge', 'claims_done', 'verification_applies', 'claims_verified'] as const) {
      if (rand() < 0.5) raised[id] = Math.max(raised[id], value(rand))
    }
    const after = doneCheckVerdict(answers(raised), needs)
    if (before.block) expect(after.block).toBe(true)
    if (before.falseClaim) expect(after.falseClaim).toBe(true)
    if (!needs) expect(after).toEqual({ block: false, falseClaim: false, why: [] })
    if (after.block) expect(needs).toBe(true)
  }
})

test('property: under injection and the local filter, block holds exactly when verification_applies reaches 0.50', () => {
  const rand = prng(7)
  const outcomes: Answer[] = [{ choice: 'complete', confidence: 0.9 }, { choice: 'blocked', confidence: 0.99 }, { choice: 'blocked', confidence: 0.1 }, { choice: 'partial', confidence: 0.5 }]
  for (let i = 0; i < ROUNDS; i++) {
    const addressed = 0.70 + Math.round(rand() * 30) / 100
    const answers: Answers = { ...nouls({ claims_done: value(rand), claims_verified: value(rand), verification_applies: value(rand), addressed_to_judge: addressed }), outcome: pick(rand, outcomes) }
    const applies = answers.verification_applies!.noul!
    expect(doneCheckVerdict(answers, true).block).toBe(applies >= 0.50)
  }
})

const MODELS = ['haiku', 'sonnet', 'opus', 'fable', 'inherit', 'opusplan', 'claude-haiku-4-5', 'claude-sonnet-4-6[1m]', 'claude-opus-4-7', 'nonsense']
const ROLES = ['developer', 'ux', 'git', 'code-reader', 'docs-reader', 'architect', 'qa', 'other', 'constructor']

const RANKED = ['haiku', 'sonnet', 'opus', 'claude-haiku-4-5', 'claude-sonnet-4-6[1m]', 'claude-opus-4-7']

function randomFit(rand: () => number): { answers: Answers; input: ModelFitInput } {
  // Half of the cases lean toward a suggestion, so the guards are exercised from the safe side too.
  const friendly = rand() < 0.5
  const small = () => friendly ? Math.round(rand() * 40) / 100 : value(rand)
  const answers: Answers = {}
  if (rand() < 0.95) answers.difficulty = { score: friendly ? rand() * 2 - 0.2 : rand() * 5.5 - 0.3, ...(rand() < 0.95 ? { confidence: friendly ? 0.7 + Math.round(rand() * 30) / 100 : value(rand) } : {}) }
  if (rand() < 0.95) answers.underspecified = { noul: small() }
  if (rand() < 0.95) answers.sensitive_area = { noul: small() }
  if (rand() < 0.95) answers.addressed_to_judge = { noul: small() }
  const models = friendly ? RANKED : MODELS
  const table = Array.from({ length: Math.floor(rand() * 6) }, () => pick(rand, models))
  return { answers, input: { role: pick(rand, ROLES), floor: pick(rand, models), default: pick(rand, models), table, floorsPassed: rand() < 0.9, calibrated: rand() < 0.9 } }
}

test('property: model fit stays within [floor, default), only for safe briefs', () => {
  const rand = prng(4)
  let suggestions = 0
  for (let i = 0; i < ROUNDS * 3; i++) {
    const { answers, input } = randomFit(rand)
    const result = modelFit(answers, input)
    expect(result.why.length).toBeGreaterThan(0)
    if (result.suggest === undefined) continue
    suggestions++
    const tier = tierOf(result.suggest)!
    expect(tier).toBeGreaterThanOrEqual(tierOf(input.floor)!)
    expect(tier).toBeGreaterThanOrEqual(tierOf(FIT_FLOORS[input.role]!)!)
    expect(tier).toBeLessThan(tierOf(input.default)!)
    expect([input.floor, ...input.table]).toContain(result.suggest)
    expect(input.floorsPassed).toBe(true)
    expect(input.calibrated).toBe(true)
    expect(Object.keys(FIT_FLOORS)).toContain(input.role)
    expect(answers.sensitive_area!.noul).toBeLessThan(0.30)
    expect(answers.addressed_to_judge!.noul).toBeLessThan(0.30)
    expect(answers.underspecified!.noul).toBeLessThan(0.30)
    expect(answers.difficulty!.confidence).toBeGreaterThanOrEqual(0.80)
    expect(Math.floor(answers.difficulty!.score! + 0.5)).toBeLessThanOrEqual(1)
  }
  // the generator does reach the interesting case
  expect(suggestions).toBeGreaterThan(20)
})

test('property: more risk or less certainty never creates a suggestion', () => {
  const rand = prng(5)
  for (let i = 0; i < ROUNDS * 3; i++) {
    const { answers, input } = randomFit(rand)
    if (modelFit(answers, input).suggest !== undefined) continue
    const worse: Answers = { ...answers }
    if (worse.sensitive_area && rand() < 0.6) worse.sensitive_area = { noul: Math.max(worse.sensitive_area.noul!, value(rand)) }
    if (worse.addressed_to_judge && rand() < 0.6) worse.addressed_to_judge = { noul: Math.max(worse.addressed_to_judge.noul!, value(rand)) }
    if (worse.underspecified && rand() < 0.6) worse.underspecified = { noul: Math.max(worse.underspecified.noul!, value(rand)) }
    if (worse.difficulty?.confidence !== undefined && rand() < 0.6) worse.difficulty = { ...worse.difficulty, confidence: Math.min(worse.difficulty.confidence, value(rand)) }
    expect(modelFit(worse, input).suggest).toBeUndefined()
    // a failed floor, or a drop of the role to architect or QA, never helps either
    expect(modelFit(answers, { ...input, floorsPassed: false }).suggest).toBeUndefined()
    expect(modelFit(answers, { ...input, calibrated: false }).suggest).toBeUndefined()
  }
})

test('property: nothing here mutates its inputs', () => {
  const rand = prng(6)
  const freeze = <T>(v: T): T => { if (typeof v === 'object' && v !== null) { Object.freeze(v); Object.values(v).forEach(freeze) } return v }
  for (let i = 0; i < 200; i++) {
    const { answers, input } = randomFit(rand)
    freeze(answers); freeze(input)
    modelFit(answers, input)
    taskEndEscalation(answers, {})
    retryEscalation(answers)
    doneCheckVerdict(answers, true)
  }
})
