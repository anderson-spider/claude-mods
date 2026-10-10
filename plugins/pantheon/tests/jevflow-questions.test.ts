import { expect, test } from 'claude-code/testing'
import {
  LAST_MESSAGE_CHARS,
  PROGRESS_LEVELS,
  buildQuestions,
  buildState,
  buildVerifyQuestion,
  judge,
  judgmentProbs,
  parseAnswers,
  summarizeChanges,
} from '../hooks/jevflow/questions'
import type { Answers, AskFn, JevJudgment, JudgeState, Questions } from '../hooks/jevflow/questions'
import type { CheckResult, Flow, Limits } from '../hooks/jevflow/types'

// Secret-looking fixtures are assembled at runtime so no source literal matches a secret scanner.
const join = (...parts: string[]) => parts.join('')

const LIMITS: Limits = {
  max_blocks_per_session: 3,
  max_restarts: 2,
  max_total_minutes: 60,
  hang_minutes: 10,
  max_jev_calls: 200,
  check_timeout_s: 60,
  state_char_budget: 12000,
  confidence: { auto: 0.9, review: 0.7, flag: 0.5, trust_check: 0.5 },
}

const FLOW: Flow = {
  goal: 'Build a CLI todo app in Python with add/list/done commands and tests',
  title: 'todo',
  schema_version: 1,
  flow_version: 'v1',
  phases: [
    { id: 'scaffold', name: 'Project scaffold', done_when: 'package layout exists', check: 'test -f todo/cli.py', depends_on: [], side_effect: false },
    { id: 'implement', name: 'Implement commands', done_when: 'add, list and done work', depends_on: ['scaffold'], side_effect: false },
    { id: 'test', name: 'Tests pass', done_when: 'a test suite exists and passes', check: 'pytest -q', depends_on: ['implement'], side_effect: false },
  ],
  limits: LIMITS,
  privacy: { send_diff: false },
}
const withFlow = (patch: Partial<Flow>): Flow => ({ ...FLOW, ...patch })

const SECRET = "def secret_function(): return 'PRIVATE_FILE_CONTENT'"
const CHECKS: Record<string, CheckResult> = {
  scaffold: { passed: true, output: 'ok' },
  test: { passed: false, output: 'E   AssertionError\n2 failed, 3 passed' },
}

const judgeState = (patch: Partial<JudgeState> = {}): JudgeState => ({
  current_phase: 'implement',
  phase_status: { scaffold: 'done', implement: 'active', test: 'pending' },
  history: [],
  ...patch,
})

/** A Jev answers object as the first call returns it for `implement` (the `unclear` probability is the rest). */
function answers(o: { phase?: string; conf?: number; stuck?: number; off?: number; claims?: number; done?: number } = {}): Answers {
  const phase = o.phase ?? 'implement'
  const conf = o.conf ?? 0.9
  return {
    current_phase: { type: 'choice', choice: phase, confidence: conf, probabilities: { [phase]: conf, unclear: 1 - conf } },
    next_action: { type: 'choice', choice: 'continue_phase', confidence: 0.7, probabilities: { continue_phase: 0.8, advance_phase: 0.2 } },
    stuck: { type: 'noul', noul: o.stuck ?? 0.1 },
    off_goal: { type: 'noul', noul: o.off ?? 0.05 },
    claims_done: { type: 'noul', noul: o.claims ?? 0.1 },
    progress: { type: 'score', score: 2.0, confidence: 0.6 },
    phase_done__implement: { type: 'noul', noul: o.done ?? 0.2 },
    phase_done__test: { type: 'noul', noul: 0.01 },
  }
}

const VERIFY = (noul: number): Answers => ({ verify: { type: 'noul', noul } })

/** A scripted `ask`: each call takes the next item, an answers object or an error to throw. */
function scripted(...script: Array<Answers | Error>) {
  const asked: Array<{ questions: Questions; state: string }> = []
  const ask: AskFn = async (questions, state) => {
    asked.push({ questions, state })
    const item = script.shift()
    if (item === undefined) throw new Error('no answer scripted')
    if (item instanceof Error) throw item
    return item
  }
  return { ask, asked }
}

async function judgeWith(ask: AskFn | null | undefined, flow: Flow = FLOW, state: JudgeState = judgeState(), extra: { maxCalls?: number; stateBudget?: number; lastMessage?: string } = {}) {
  return (await judge(ask, flow, state, { checks: CHECKS, lastMessage: 'hi', ...extra })).judgment
}

async function judged(ask: AskFn | null | undefined, flow?: Flow, state?: JudgeState, extra?: { maxCalls?: number; stateBudget?: number; lastMessage?: string }): Promise<JevJudgment> {
  const result = await judgeWith(ask, flow, state, extra)
  if (result === null) throw new Error('expected a judgment, got null')
  return result
}

// --- buildState ---

test('buildState keeps the state keys, phases in flow order, and reads check results as pass or fail with the tail', () => {
  const doc = JSON.parse(buildState(FLOW, judgeState(), { checks: CHECKS, lastMessage: 'added add command' }))
  expect(Object.keys(doc)).toEqual(['goal', 'phases', 'current_phase', 'check_results', 'last_assistant_message', 'change_summary', 'recent_history'])
  expect(doc.goal).toBe(FLOW.goal)
  expect(doc.phases.map((p: { id: string }) => p.id)).toEqual(['scaffold', 'implement', 'test'])
  expect(doc.phases[0].status).toBe('done')
  expect(doc.phases[2].status).toBe('pending')
  expect(doc.check_results.scaffold).toBe('pass')
  expect(doc.check_results.test.startsWith('fail: ')).toBe(true)
  expect(doc.check_results.test).toContain('2 failed')
  expect(doc.last_assistant_message).toBe('added add command')
})

test('buildState keeps a missing check and a phase without status as pending', () => {
  const doc = JSON.parse(buildState(FLOW, judgeState({ phase_status: {} }), { checks: { scaffold: { passed: null, output: '' } } }))
  expect(doc.check_results.scaffold).toBe('no check')
  expect(doc.phases.map((p: { status: string }) => p.status)).toEqual(['pending', 'pending', 'pending'])
})

test('buildState truncates the last message to its tail, LAST_MESSAGE_CHARS at most', () => {
  const doc = JSON.parse(buildState(FLOW, judgeState(), { checks: {}, lastMessage: 'x'.repeat(10000) + 'THE_END' }))
  expect(doc.last_assistant_message.length).toBeLessThanOrEqual(LAST_MESSAGE_CHARS)
  expect(doc.last_assistant_message.startsWith('...')).toBe(true)
  expect(doc.last_assistant_message.endsWith('THE_END')).toBe(true)
})

test('buildState shows the last 5 decisions only, and leaves out journal entries that are not decisions', () => {
  const history = Array.from({ length: 9 }, (_, i) => ({ decision: 'BLOCK', phase: 'implement', reason: `r${i}` }))
  history.push({ event: 'session_start' } as never)
  const doc = JSON.parse(buildState(FLOW, judgeState({ history }), { checks: {} }))
  expect(doc.recent_history.length).toBe(5)
  expect(doc.recent_history[4]).toBe('BLOCK implement: r8')
  expect(doc.recent_history[0]).toBe('BLOCK implement: r4')
})

test('buildState trims to every budget it is given, staying valid JSON with the goal and the three phases', () => {
  const history = Array.from({ length: 20 }, () => ({ decision: 'BLOCK', phase: 'x', reason: 'y'.repeat(300) }))
  const big: Record<string, CheckResult> = { test: { passed: false, output: 'z'.repeat(5000) } }
  const changes = Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.py`, added: i, removed: 0 }))
  for (const budget of [12000, 6000, 3000, 1500]) {
    const out = buildState(FLOW, judgeState({ history }), { checks: big, lastMessage: 'm'.repeat(9000), changes, budget })
    expect(out.length).toBeLessThanOrEqual(budget)
    const doc = JSON.parse(out)
    expect(doc.goal).toBe(FLOW.goal)
    expect(doc.phases.length).toBe(3)
  }
})

test('buildState uses the flow state_char_budget when no budget is given', () => {
  const out = buildState(withFlow({ limits: { ...LIMITS, state_char_budget: 2000 } }), judgeState(), { checks: {}, lastMessage: 'm'.repeat(9000) })
  expect(out.length).toBeLessThanOrEqual(2000)
})

test('buildState sends no file contents by default: only the path and the line counts', () => {
  const changes = [{ path: 'todo/cli.py', added: 40, removed: 2, diff: SECRET }]
  const out = buildState(FLOW, judgeState(), { checks: {}, changes })
  expect(out).not.toContain('PRIVATE_FILE_CONTENT')
  expect(out).toContain('todo/cli.py +40 -2')
})

test('buildState sends the diff when privacy.send_diff is true', () => {
  const changes = [{ path: 'todo/cli.py', added: 40, removed: 2, diff: SECRET }]
  const out = buildState(withFlow({ privacy: { send_diff: true } }), judgeState(), { checks: {}, changes })
  expect(out).toContain('PRIVATE_FILE_CONTENT')
})

test('buildState redacts secrets and emails before the state leaves', () => {
  const token = join('sk-or-', 'v1-0123456789abcdef0123456789abcdef0123456789abcdef')
  const out = buildState(FLOW, judgeState(), { checks: {}, lastMessage: `curl with ${token} for ops@example.com` })
  expect(out).not.toContain(token)
  expect(out).not.toContain('ops@example.com')
  expect(JSON.parse(out).last_assistant_message).toContain('[redacted]')
})

test('summarizeChanges lists the largest changes first, capped at MAX_CHANGE_FILES with a count of the rest', () => {
  const changes = Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.py`, added: i, removed: 0 }))
  const s = summarizeChanges(changes, false)
  expect(s.length).toBe(41)
  expect(s[0]).toBe('f59.py +59 -0')
  expect(s[40]).toBe('... and 20 more files')
})

// --- questions ---

test('buildQuestions asks the v3 set: phase and next action with unclear, three yes/no questions, progress levels', () => {
  const q = buildQuestions(FLOW, 'implement')
  expect(Object.keys(q)).toEqual(['current_phase', 'next_action', 'stuck', 'off_goal', 'claims_done', 'progress', 'phase_done__implement', 'phase_done__test'])
  expect(q.current_phase).toMatchObject({ type: 'choice' })
  const phaseCriteria = (q.current_phase as { criteria: Record<string, string> }).criteria
  expect(Object.keys(phaseCriteria)).toEqual(['scaffold', 'implement', 'test', 'unclear'])
  expect(phaseCriteria.implement).toBe('Implement commands: add, list and done work')
  const nextCriteria = (q.next_action as { criteria: Record<string, string> }).criteria
  expect(Object.keys(nextCriteria)).toEqual(['continue_phase', 'advance_phase', 'fix_regression', 'ask_human', 'goal_complete', 'unclear'])
  expect(q.progress).toEqual({ type: 'score', instructions: 'How far the work has progressed toward the whole goal', criteria: PROGRESS_LEVELS })
  for (const name of ['stuck', 'off_goal', 'claims_done']) expect(q[name]).toMatchObject({ type: 'noul' })
})

test('buildQuestions adds phase_done for the current phase and the next one only, none after the last phase', () => {
  const middle = Object.keys(buildQuestions(FLOW, 'implement')).filter(k => k.startsWith('phase_done__'))
  expect(middle).toEqual(['phase_done__implement', 'phase_done__test'])
  const last = Object.keys(buildQuestions(FLOW, 'test')).filter(k => k.startsWith('phase_done__'))
  expect(last).toEqual(['phase_done__test'])
})

test('buildQuestions asks no attribution question: no why, no cause, no root cause', () => {
  const text = JSON.stringify(buildQuestions(FLOW, 'implement')).toLowerCase()
  for (const banned of ['why', 'which step caused', 'root cause']) expect(text).not.toContain(banned)
})

test('buildVerifyQuestion asks whether the phase is done, with the phase name and done_when', () => {
  expect(buildVerifyQuestion(FLOW, 'implement')).toEqual({
    verify: { type: 'noul', instructions: "The agent has fully completed the 'Implement commands' phase: add, list and done work" },
  })
})

// --- parsing ---

test('parseAnswers reads the phase, the next action, the noul values, the normalised progress and phase_done', () => {
  const j = parseAnswers(FLOW, answers({ done: 0.85 }))
  expect(j.current_phase).toBe('implement')
  expect(j.current_phase_conf).toBe(0.9)
  expect(j.current_phase_probs.implement).toBe(0.9)
  expect(Object.keys(j.current_phase_probs)).toEqual(['implement', 'unclear'])
  expect(j.next_action).toBe('continue_phase')
  expect(j.stuck).toBe(0.1)
  expect(j.phase_done).toEqual({ implement: 0.85, test: 0.01 })
  expect(j.progress).toBe(0.5)
  expect(j.progress_conf).toBe(0.6)
  expect(j.verify).toBeNull()
  expect(j.calls).toBe(0)
})

test('parseAnswers falls back to the most probable option when the choice is not one of them', () => {
  const a = answers()
  a.current_phase = { type: 'choice', choice: 'bogus', probabilities: { test: 0.7, implement: 0.2, bogus: 0.1 } }
  const j = parseAnswers(FLOW, a)
  expect(j.current_phase).toBe('test')
  expect(j.current_phase_conf).toBe(0.7)
})

test('parseAnswers rejects a non-finite number, a missing answer or a bad progress score', () => {
  const nan = answers()
  nan.stuck = { type: 'noul', noul: Number.NaN }
  expect(() => parseAnswers(FLOW, nan)).toThrow()
  const inf = answers()
  inf.off_goal = { type: 'noul', noul: Number.POSITIVE_INFINITY }
  expect(() => parseAnswers(FLOW, inf)).toThrow()
  const missing = answers()
  delete missing.stuck
  expect(() => parseAnswers(FLOW, missing)).toThrow()
  const badScore = answers()
  badScore.progress = { type: 'score', score: Number.NaN }
  expect(() => parseAnswers(FLOW, badScore)).toThrow()
})

test('judgmentProbs is the compact journal form: pairs for the phase, numbers otherwise', () => {
  const j = parseAnswers(FLOW, answers({ done: 0.2 }))
  j.verify = 0.5
  j.verify_phase = 'implement'
  const p = judgmentProbs(j)
  expect(p.current_phase).toEqual(['implement', 0.9])
  expect(p.verify).toEqual(['implement', 0.5])
  expect(p.phase_done__implement).toBe(0.2)
  expect(p.progress).toBe(0.5)
})

// --- judge ---

test('judge makes the main call, then the verify call on the same state when a phase wins', async () => {
  const s = scripted(answers({ done: 0.85 }), VERIFY(0.83))
  const j = await judged(s.ask)
  expect(j.current_phase).toBe('implement')
  expect(j.verify_phase).toBe('implement')
  expect(j.verify).toBe(0.83)
  expect(j.phase_done.implement).toBe(0.85)
  expect(j.calls).toBe(2)
  expect(Object.keys(s.asked[1]!.questions)).toEqual(['verify'])
  expect(s.asked[0]!.state).toBe(s.asked[1]!.state)
  expect(j.error).toBeNull()
})

test('judge skips verify when the phase is unclear', async () => {
  const s = scripted(answers({ phase: 'unclear', conf: 0.6 }))
  const j = await judged(s.ask)
  expect(j.current_phase).toBe('unclear')
  expect(j.verify).toBeNull()
  expect(j.verify_phase).toBeNull()
  expect(j.calls).toBe(1)
  expect(s.asked.length).toBe(1)
})

test('judge returns null when the first call throws, so the caller degrades', async () => {
  const s = scripted(new Error('Jev HTTP 503: down'))
  expect(await judgeWith(s.ask)).toBeNull()
})

test('a judgment Jev did not give still reports the calls spent and why', async () => {
  const failed = await judge(scripted(new Error('Jev HTTP 503: down')).ask, FLOW, judgeState(), { checks: CHECKS })
  expect(failed).toEqual({ judgment: null, calls: 1, error: 'Jev error: Jev HTTP 503: down' })
  const none = await judge(undefined, FLOW, judgeState(), { checks: CHECKS })
  expect(none.calls).toBe(0)
  expect(none.error).toContain('judgeKey')
})

test('judge returns null with no ask, the same as with no client', async () => {
  expect(await judgeWith(null)).toBeNull()
  expect(await judgeWith(undefined)).toBeNull()
})

test('judge returns null without sending anything when the call budget is spent', async () => {
  const s = scripted(answers())
  expect(await judgeWith(s.ask, FLOW, judgeState(), { maxCalls: 0 })).toBeNull()
  expect(s.asked.length).toBe(0)
})

test('judge keeps the first call when the verify call is past the budget, with verify null and the reason in error', async () => {
  const s = scripted(answers({ done: 0.85 }), VERIFY(0.83))
  const j = await judged(s.ask, FLOW, judgeState(), { maxCalls: 1 })
  expect(s.asked.length).toBe(1)
  expect(j.verify).toBeNull()
  expect(j.error).toBe('verify failed: budget')
  expect(j.calls).toBe(1)
})

test('judge returns null when the answers are malformed', async () => {
  const bad = answers()
  delete bad.stuck
  expect(await judgeWith(scripted(bad).ask)).toBeNull()
})

test('judge returns null on a non-finite number in the first call', async () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const a = answers()
    a.stuck = { type: 'noul', noul: bad }
    expect(await judgeWith(scripted(a).ask)).toBeNull()
  }
  const progress = answers()
  progress.progress = { type: 'score', score: Number.NaN }
  expect(await judgeWith(scripted(progress).ask)).toBeNull()
})

test('judge keeps the first call when the verify call fails, with verify null and error set', async () => {
  const j = await judged(scripted(answers(), new Error('HTTP 500')).ask)
  expect(j.verify).toBeNull()
  expect(j.error).toBe('verify failed: error')
  expect(j.current_phase).toBe('implement')
})

test('judge marks a malformed verify answer as such and keeps the first call', async () => {
  const j = await judged(scripted(answers(), { verify: { type: 'noul' } }).ask)
  expect(j.verify).toBeNull()
  expect(j.error).toBe('verify failed: malformed answer')
})

test('judge reads an unknown choice as the argmax, and the confidence of that choice', async () => {
  const a = answers()
  a.current_phase = { type: 'choice', choice: 'bogus', probabilities: { test: 0.7, implement: 0.2, bogus: 0.1 } }
  const j = await judged(scripted(a, VERIFY(0.1)).ask)
  expect(j.current_phase).toBe('test')
  expect(j.current_phase_conf).toBe(0.7)
})

test('judge trims the state to the stateBudget cap when that is smaller than the flow budget', async () => {
  const s = scripted(answers(), VERIFY(0.5))
  await judged(s.ask, FLOW, judgeState(), { stateBudget: 1500, lastMessage: 'm'.repeat(9000) })
  expect(s.asked[0]!.state.length).toBeLessThanOrEqual(1500)
  expect(JSON.parse(s.asked[0]!.state).goal).toBe(FLOW.goal)
})
