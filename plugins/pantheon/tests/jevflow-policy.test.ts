import { expect, test } from 'claude-code/testing'
import { applyDecision, decide, OUTPUT_CHARS } from '../hooks/jevflow/policy'
import type { DecideOptions } from '../hooks/jevflow/policy'
import { ADVANCE, ALLOW_STOP, BLOCK, UNCLEAR } from '../hooks/jevflow/types'
import type { CheckResult, Confidence, Decision, Flow, FlowState, Judgment, Limits, Phase, PhaseStatus } from '../hooks/jevflow/types'

// Port of JevFlow tests/test_policy.py (the sub-step rows and the shadow-mode rows are dropped with those features).

const GOAL = 'Build a CLI todo app'

type PhaseDoc = {
  id: string
  name: string
  done_when: string
  check?: string
  depends_on?: string[]
  loop?: { max_iterations: number; until: string }
  on_fail?: string
}
type FlowDoc = { goal?: string; phases: PhaseDoc[]; limits?: Partial<Omit<Limits, 'confidence'>> & { confidence?: Partial<Confidence> } }

// Stand-in for parse_flow: a phase without depends_on depends on the phase listed before it.
const flowOf = (doc: FlowDoc): Flow => {
  const phases: Phase[] = doc.phases.map((p, i) => ({
    id: p.id,
    name: p.name,
    done_when: p.done_when,
    ...(p.check !== undefined ? { check: p.check } : {}),
    depends_on: p.depends_on ?? (i > 0 ? [doc.phases[i - 1]?.id ?? ''] : []),
    ...(p.loop !== undefined ? { loop: p.loop } : {}),
    ...(p.on_fail !== undefined ? { on_fail: p.on_fail } : {}),
    side_effect: false,
  }))
  const limits: Limits = {
    max_blocks_per_session: 6,
    max_restarts: 5,
    max_total_minutes: 90,
    hang_minutes: 10,
    max_jev_calls: 200,
    check_timeout_s: 120,
    state_char_budget: 12000,
    ...doc.limits,
    confidence: { auto: 0.8, review: 0.5, flag: 0.7, trust_check: 0.9, ...doc.limits?.confidence },
  }
  return { goal: doc.goal ?? GOAL, title: '', schema_version: 1, flow_version: '1', phases, limits, privacy: { send_diff: false } }
}

const LINEAR: FlowDoc = {
  phases: [
    { id: 'scaffold', name: 'Scaffold', done_when: 'layout exists', check: 'test -f x' },
    { id: 'implement', name: 'Implement', done_when: 'commands work' },
    { id: 'test', name: 'Tests', done_when: 'suite passes', check: 'pytest -q' },
  ],
}
const LOOPED: FlowDoc = {
  phases: [
    { id: 'implement', name: 'Implement', done_when: 'commands work' },
    { id: 'test', name: 'Tests', done_when: 'suite passes', check: 'pytest -q', loop: { max_iterations: 3, until: 'pytest -q' } },
  ],
}
const BRANCH: FlowDoc = {
  phases: [
    { id: 'implement', name: 'Implement', done_when: 'commands work' },
    { id: 'test', name: 'Tests', done_when: 'suite passes', check: 'pytest -q', on_fail: 'debug' },
    { id: 'debug', name: 'Debug', done_when: 'root cause fixed', depends_on: [] },
  ],
}
const LOOP_BRANCH: FlowDoc = {
  phases: [
    { id: 'test', name: 'Tests', done_when: 'suite passes', check: 'pytest -q', loop: { max_iterations: 2, until: 'pytest -q' }, on_fail: 'debug' },
    { id: 'debug', name: 'Debug', done_when: 'root cause fixed', depends_on: [] },
  ],
}
const DAG: FlowDoc = {
  phases: [
    { id: 'api', name: 'API', done_when: 'api done', depends_on: [] },
    { id: 'cli', name: 'CLI', done_when: 'cli done', depends_on: ['api'] },
    { id: 'docs', name: 'Docs', done_when: 'docs done', depends_on: [] },
    { id: 'ship', name: 'Ship', done_when: 'shipped', depends_on: ['cli', 'docs'] },
  ],
}

const PASS: CheckResult = { passed: true, output: 'ok' }
const FAIL: CheckResult = { passed: false, output: '2 failed, 3 passed\nAssertionError: expected 3' }

type JOpts = Partial<Judgment> & { conf?: number; verify?: number }
/** Confident judgment for `phase`; verify defaults to 'not done'. */
const J = (phase: string, o: JOpts = {}): Judgment => {
  const { conf, verify, ...rest } = o
  return {
    current_phase: phase,
    current_phase_conf: conf ?? 0.95,
    current_phase_probs: {},
    next_action: 'continue_phase',
    next_action_conf: 0.9,
    phase_done: {},
    verify_phase: phase === UNCLEAR ? null : phase,
    verify: verify ?? 0.05,
    stuck: 0.05,
    off_goal: 0.02,
    claims_done: 0.05,
    ...rest,
  }
}

/** Python's S(): every phase pending, the given phases done, `cur` active, started at 1000. */
const stateOf = (flow: Flow, cur: string, done: string[] = [], patch: Partial<FlowState> = {}): FlowState => {
  const status: Record<string, PhaseStatus> = {}
  for (const p of flow.phases) status[p.id] = 'pending'
  for (const pid of done) status[pid] = 'done'
  status[cur] = 'active'
  return {
    state_schema: 1,
    flow_version: flow.flow_version,
    current_phase: cur,
    phase_status: status,
    blocks_this_session: 0,
    restarts: 0,
    jev_calls: 0,
    loop_iterations: {},
    phase_attempts: flow.phases[0] ? { [flow.phases[0].id]: 1 } : {},
    consecutive_blocks: 0,
    stuck_streak: 0,
    escalations: 0,
    same_reason_count: 0,
    needs_human: null,
    last_failure: null,
    review_streak: null,
    last_block_reason: null,
    last_error: null,
    started_at: 1000,
    updated_at: 1000,
    history: [],
    done: false,
    agents: {},
    ...patch,
  }
}

// --- the policy table: one test per row of CASES in test_policy.py ---

type Row = {
  name: string
  flow: FlowDoc
  cur: string
  done?: string[]
  patch?: Partial<FlowState>
  judgment: Judgment | null
  checks: Record<string, CheckResult>
  opts?: DecideOptions
  now?: number
  kind: string
  condition: string
  toPhase?: string
}

const CASES: Row[] = [
  { name: 'already_done', flow: LINEAR, cur: 'test', done: ['scaffold', 'implement'], patch: { done: true }, judgment: J('test'), checks: {}, kind: ALLOW_STOP, condition: 'already_done' },
  { name: 'budget_blocks', flow: LINEAR, cur: 'implement', done: ['scaffold'], patch: { blocks_this_session: 6 }, judgment: J('implement'), checks: {}, kind: ALLOW_STOP, condition: 'budget_blocks' },
  { name: 'budget_time', flow: LINEAR, cur: 'implement', done: ['scaffold'], judgment: J('implement'), checks: {}, now: 1000 + 91 * 60, kind: ALLOW_STOP, condition: 'budget_time' },
  { name: 'budget_jev', flow: LINEAR, cur: 'implement', done: ['scaffold'], patch: { jev_calls: 200 }, judgment: J('implement'), checks: {}, kind: ALLOW_STOP, condition: 'budget_jev' },
  { name: 'hook_cap', flow: LINEAR, cur: 'implement', done: ['scaffold'], patch: { consecutive_blocks: 7, blocks_this_session: 0 }, judgment: J('implement'), checks: {}, opts: { stop_hook_active: true }, kind: ALLOW_STOP, condition: 'hook_cap' },
  { name: 'hook_cap_resets_without_stop_hook_active', flow: LINEAR, cur: 'implement', done: ['scaffold'], patch: { consecutive_blocks: 7 }, judgment: J('implement'), checks: {}, opts: { stop_hook_active: false }, kind: BLOCK, condition: 'drop_band' },
  { name: 'regression', flow: LINEAR, cur: 'implement', done: ['scaffold'], judgment: J('implement'), checks: { scaffold: FAIL }, kind: BLOCK, condition: 'regression', toPhase: 'scaffold' },
  { name: 'loop_continue', flow: LOOPED, cur: 'test', done: ['implement'], judgment: J('test'), checks: { test: FAIL }, opts: { loop_checks: { test: FAIL } }, kind: BLOCK, condition: 'loop_continue' },
  { name: 'loop_until_pass_but_check_fails', flow: LOOPED, cur: 'test', done: ['implement'], judgment: J('test'), checks: { test: FAIL }, opts: { loop_checks: { test: PASS } }, kind: BLOCK, condition: 'loop_continue' },
  { name: 'loop_pass', flow: LOOPED, cur: 'test', done: ['implement'], judgment: J('test'), checks: { test: PASS }, opts: { loop_checks: { test: PASS } }, kind: ALLOW_STOP, condition: 'goal_complete' },
  { name: 'loop_exhausted', flow: LOOPED, cur: 'test', done: ['implement'], patch: { loop_iterations: { test: 3 } }, judgment: J('test'), checks: { test: FAIL }, opts: { loop_checks: { test: FAIL } }, kind: ALLOW_STOP, condition: 'loop_exhausted' },
  { name: 'loop_exhausted_on_fail', flow: LOOP_BRANCH, cur: 'test', patch: { loop_iterations: { test: 2 } }, judgment: J('test'), checks: { test: FAIL }, opts: { loop_checks: { test: FAIL } }, kind: ADVANCE, condition: 'loop_exhausted_on_fail', toPhase: 'debug' },
  { name: 'degraded_check_pass', flow: LINEAR, cur: 'scaffold', judgment: null, checks: { scaffold: PASS }, opts: { degraded_reason: 'JevHTTPError: 503' }, kind: ADVANCE, condition: 'degraded_check_pass', toPhase: 'implement' },
  { name: 'degraded_check_fail', flow: LINEAR, cur: 'test', done: ['scaffold', 'implement'], judgment: null, checks: { scaffold: PASS, test: FAIL }, opts: { degraded_reason: 'timeout' }, kind: BLOCK, condition: 'degraded_check_fail' },
  { name: 'degraded_no_check', flow: LINEAR, cur: 'implement', done: ['scaffold'], judgment: null, checks: { scaffold: PASS }, kind: ALLOW_STOP, condition: 'degraded_no_check' },
  { name: 'ask_human', flow: LINEAR, cur: 'implement', done: ['scaffold'], judgment: J('implement', { next_action: 'ask_human', next_action_conf: 0.85 }), checks: {}, kind: ALLOW_STOP, condition: 'ask_human' },
  { name: 'ask_human_low_conf_ignored', flow: LINEAR, cur: 'implement', done: ['scaffold'], judgment: J('implement', { next_action: 'ask_human', next_action_conf: 0.6 }), checks: {}, kind: BLOCK, condition: 'drop_band' },
  { name: 'stuck_once', flow: LINEAR, cur: 'test', done: ['scaffold', 'implement'], judgment: J('test', { stuck: 0.95 }), checks: { test: FAIL }, kind: BLOCK, condition: 'stuck' },
  { name: 'stuck_twice_escalates', flow: LINEAR, cur: 'test', done: ['scaffold', 'implement'], patch: { stuck_streak: 1 }, judgment: J('test', { stuck: 0.95 }), checks: { test: FAIL }, kind: BLOCK, condition: 'stuck_escalate' },
  { name: 'same_reason_3x_escalates', flow: LINEAR, cur: 'test', done: ['scaffold', 'implement'], patch: { same_reason_count: 3 }, judgment: J('test'), checks: { test: FAIL }, kind: BLOCK, condition: 'stuck_escalate' },
  { name: 'stuck_third_escalation_asks_human', flow: LINEAR, cur: 'test', done: ['scaffold', 'implement'], patch: { stuck_streak: 1, escalations: 2 }, judgment: J('test', { stuck: 0.95 }), checks: { test: FAIL }, kind: ALLOW_STOP, condition: 'stuck_ask_human' },
  { name: 'off_goal', flow: LINEAR, cur: 'implement', done: ['scaffold'], judgment: J('implement', { off_goal: 0.9 }), checks: {}, kind: BLOCK, condition: 'off_goal' },
  { name: 'on_fail_branch', flow: BRANCH, cur: 'test', done: ['implement'], judgment: J('test', { claims_done: 0.93 }), checks: { test: FAIL }, kind: ADVANCE, condition: 'on_fail', toPhase: 'debug' },
  { name: 'premature_completion', flow: LINEAR, cur: 'test', done: ['scaffold', 'implement'], judgment: J('test', { claims_done: 0.93 }), checks: { scaffold: PASS, test: FAIL }, kind: BLOCK, condition: 'premature_completion' },
  { name: 'unclear_never_advances', flow: LINEAR, cur: 'scaffold', judgment: J(UNCLEAR, { conf: 0.9 }), checks: { scaffold: PASS }, kind: BLOCK, condition: 'unclear' },
  { name: 'advance_with_check', flow: LINEAR, cur: 'scaffold', judgment: J('scaffold', { verify: 0.9 }), checks: { scaffold: PASS }, kind: ADVANCE, condition: 'advance', toPhase: 'implement' },
  { name: 'advance_no_check_phase', flow: LINEAR, cur: 'implement', done: ['scaffold'], judgment: J('implement', { conf: 0.83, verify: 0.83 }), checks: { scaffold: PASS }, kind: ADVANCE, condition: 'advance', toPhase: 'test' },
  { name: 'check_pass_but_verify_low_keeps_phase', flow: LINEAR, cur: 'scaffold', judgment: J('scaffold', { verify: 0.1 }), checks: { scaffold: PASS }, kind: BLOCK, condition: 'drop_band' },
  { name: 'check_not_run_never_advances', flow: LINEAR, cur: 'scaffold', judgment: J('scaffold', { verify: 0.95 }), checks: {}, kind: BLOCK, condition: 'continue' },
  { name: 'low_conf_never_advances', flow: LINEAR, cur: 'scaffold', judgment: J('scaffold', { conf: 0.4, verify: 0.95 }), checks: { scaffold: PASS }, kind: BLOCK, condition: 'drop_band' },
  { name: 'review_band_note', flow: LINEAR, cur: 'implement', done: ['scaffold'], judgment: J('implement', { conf: 0.9, verify: 0.65 }), checks: {}, kind: BLOCK, condition: 'review_band' },
  { name: 'phase_mismatch_keeps_current', flow: LINEAR, cur: 'implement', done: ['scaffold'], judgment: J('test', { conf: 0.9, verify: 0.9 }), checks: {}, kind: BLOCK, condition: 'phase_mismatch' },
  { name: 'goal_complete', flow: LINEAR, cur: 'test', done: ['scaffold', 'implement'], judgment: J('test', { verify: 0.9 }), checks: { scaffold: PASS, test: PASS }, kind: ALLOW_STOP, condition: 'goal_complete' },
  { name: 'dag_eligibility', flow: DAG, cur: 'api', judgment: J('api', { verify: 0.9 }), checks: {}, kind: ADVANCE, condition: 'advance', toPhase: 'cli' },
  { name: 'dag_waits_for_all_deps', flow: DAG, cur: 'cli', done: ['api'], judgment: J('cli', { verify: 0.9 }), checks: {}, kind: ADVANCE, condition: 'advance', toPhase: 'docs' },
  { name: 'branch_only_not_required_for_goal', flow: BRANCH, cur: 'test', done: ['implement'], judgment: J('test', { verify: 0.9 }), checks: { test: PASS }, kind: ALLOW_STOP, condition: 'goal_complete' },
  { name: 'branch_returns_to_failed_phase', flow: BRANCH, cur: 'debug', done: ['implement'], judgment: J('debug', { verify: 0.9 }), checks: { test: FAIL }, kind: ADVANCE, condition: 'advance', toPhase: 'test' },
  { name: 'bad_state_asks_human', flow: LINEAR, cur: 'scaffold', patch: { current_phase: 'ghost' }, judgment: J('scaffold'), checks: {}, kind: ALLOW_STOP, condition: 'bad_state' },
]

for (const row of CASES) {
  test(`policy table: ${row.name}`, () => {
    const flow = flowOf(row.flow)
    const state = stateOf(flow, row.cur, row.done ?? [], row.patch ?? {})
    const before = JSON.stringify(state)
    const d = decide(flow, state, row.judgment, row.checks, row.now ?? 1060, row.opts)
    expect(JSON.stringify(state)).toBe(before)
    expect([d.kind, d.condition]).toEqual([row.kind, row.condition])
    expect(d.to_phase).toBe(row.toPhase)
    if (d.kind === BLOCK || d.kind === ADVANCE) expect(d.reason.trim()).not.toBe('')
  })
}

// --- details (TestPolicyDetails, TestReviewStreak, TestLoopMessage) ---

const linear = flowOf(LINEAR)
const at1060 = (flow: Flow, state: FlowState, j: Judgment | null, checks: Record<string, CheckResult>, opts?: DecideOptions) =>
  decide(flow, state, j, checks, 1060, opts)

test('block reason quotes the failing check output and names the phase', () => {
  const s = stateOf(linear, 'test', ['scaffold', 'implement'])
  const d = at1060(linear, s, J('test', { claims_done: 0.93 }), { scaffold: PASS, test: FAIL })
  expect(d.reason).toContain('AssertionError: expected 3')
  expect(d.reason).toContain('suite passes')
})

test('a long check output is cut to the tail, with the end kept', () => {
  const s = stateOf(linear, 'test', ['scaffold', 'implement'])
  const d = at1060(linear, s, J('test', { claims_done: 0.93 }), { scaffold: PASS, test: { passed: false, output: 'x'.repeat(10000) + 'TAIL' } })
  expect(d.reason.length).toBeLessThan(OUTPUT_CHARS + 400)
  expect(d.reason).toContain('TAIL')
})

test('applying an advance moves the phase table and spends no block budget', () => {
  const s = stateOf(linear, 'scaffold')
  const d = at1060(linear, s, J('scaffold', { verify: 0.9 }), { scaffold: PASS })
  const next = applyDecision(s, d, 1060)
  expect(next.current_phase).toBe('implement')
  expect(next.phase_status.scaffold).toBe('done')
  expect(next.phase_status.implement).toBe('active')
  expect(next.blocks_this_session).toBe(0)
  expect(next.consecutive_blocks).toBe(1)
})

test('budget exhausted but finished completes; still failing stops with the budget reason', () => {
  const s = stateOf(linear, 'test', ['scaffold', 'implement'], { blocks_this_session: 99 })
  expect(at1060(linear, s, J('test'), { scaffold: PASS, test: PASS }).condition).toBe('goal_complete')
  expect(at1060(linear, s, J('test'), { scaffold: PASS, test: FAIL }).condition).toBe('budget_blocks')
})

test('budget out without checks just stops, and says so', () => {
  const flow = flowOf(DAG)
  const s = stateOf(flow, 'cli', ['api'], { blocks_this_session: 6 })
  // DAG phases define no checks, so nothing can be settled
  const d = decide(flow, s, J('cli'), { cli: PASS, docs: PASS, ship: FAIL }, 1000)
  expect(d.condition).toBe('budget_blocks')
  expect(d.reason).toContain('reply')
})

test('budget out marks the passing current phase done and moves on; all passing completes', () => {
  const flow = flowOf({
    goal: GOAL,
    phases: [
      { id: 'tests', name: 'Tests', done_when: 'pytest passes', check: 'pytest' },
      { id: 'docs', name: 'Docs', done_when: 'README', check: 'test -f README.md' },
      { id: 'ship', name: 'Ship', done_when: 'shipped', check: 'false' },
    ],
  })
  const s = stateOf(flow, 'tests', [], { blocks_this_session: 6 })
  const d = decide(flow, s, J('tests', { conf: 0.6, verify: 0.6 }), { tests: PASS, docs: PASS, ship: FAIL }, 1000)
  expect(d.condition).toBe('budget_blocks')
  const next = applyDecision(s, d, 1000)
  expect(next.phase_status).toEqual({ tests: 'done', docs: 'done', ship: 'active' })
  expect(next.current_phase).toBe('ship')

  const s2 = stateOf(flow, 'tests', [], { blocks_this_session: 6 })
  const d2 = decide(flow, s2, J('tests'), { tests: PASS, docs: PASS, ship: PASS }, 1000)
  expect(d2.condition).toBe('goal_complete')
  const done = applyDecision(s2, d2, 1000)
  expect(done.done).toBe(true)
  expect(Object.values(done.phase_status).every((v) => v === 'done')).toBe(true)
})

test('the review streak survives an off-goal hold and the next review-band stop advances', () => {
  const flow = flowOf({
    goal: GOAL,
    phases: [
      { id: 'tests', name: 'Tests', done_when: 'pytest passes', check: 'pytest' },
      { id: 'docs', name: 'Docs', done_when: 'README', check: 'test -f README.md' },
    ],
  })
  const band = J('tests', { conf: 0.6, verify: 0.6 })
  let s = stateOf(flow, 'tests')
  s = applyDecision(s, decide(flow, s, band, { tests: PASS }, 1000), 1000)
  expect(s.review_streak).toEqual({ phase: 'tests', n: 1 })
  const off = decide(flow, s, J('tests', { off_goal: 0.9 }), { tests: PASS }, 1000)
  expect(off.condition).toBe('off_goal')
  s = applyDecision(s, off, 1000)
  expect(s.review_streak).toEqual({ phase: 'tests', n: 1 })
  expect(decide(flow, s, band, { tests: PASS }, 1000).condition).toBe('review_check_pass')
})

test('every cap completes a finished flow before it stops the flow', () => {
  const cases: { patch: Partial<FlowState>; now: number; opts: DecideOptions; condition: string }[] = [
    { patch: { consecutive_blocks: 7 }, now: 1060, opts: { stop_hook_active: true }, condition: 'hook_cap' },
    { patch: {}, now: 1000 + 91 * 60, opts: {}, condition: 'budget_time' },
    { patch: { jev_calls: 200 }, now: 1060, opts: {}, condition: 'budget_jev' },
  ]
  for (const c of cases) {
    const s = stateOf(linear, 'test', ['scaffold', 'implement'], c.patch)
    const d = decide(linear, s, J('test', { conf: 0.6 }), { scaffold: PASS, test: PASS }, c.now, c.opts)
    expect(d.condition).toBe('goal_complete')
    expect(d.patch.done).toBe(true)
    const s2 = stateOf(linear, 'test', ['scaffold', 'implement'], c.patch)
    expect(decide(linear, s2, J('test'), { scaffold: PASS, test: FAIL }, c.now, c.opts).condition).toBe(c.condition)
  }
})

test('a cap settles a passing loop phase and counts the passing run', () => {
  const flow = flowOf(LOOPED)
  const s = stateOf(flow, 'test', ['implement'], { blocks_this_session: 6 })
  const d = decide(flow, s, J('test'), { test: PASS }, 1000, { loop_checks: { test: PASS } })
  expect(d.condition).toBe('goal_complete')
  expect(applyDecision(s, d, 1000).loop_iterations.test).toBe(1)
})

test('a passing check with phase_done at trust advances instead of holding in the review band', () => {
  const doc: FlowDoc = {
    goal: GOAL,
    phases: [
      { id: 'evens', name: 'Evens', done_when: 'evens()', check: 'pytest -k evens' },
      { id: 'odds', name: 'Odds', done_when: 'odds()', check: 'pytest -k odds' },
    ],
  }
  const flow = flowOf(doc)
  const s = stateOf(flow, 'evens')
  const advance = decide(flow, s, J('evens', { conf: 0.77, verify: 0.6, phase_done: { evens: 0.97 } }), { evens: PASS }, 1000)
  expect([advance.kind, advance.condition, advance.to_phase]).toEqual([ADVANCE, 'check_and_phase_done', 'odds'])
  // below the trust threshold, or with a failing check, it still holds
  const held = decide(flow, s, J('evens', { conf: 0.77, verify: 0.6, phase_done: { evens: 0.85 } }), { evens: PASS }, 1000)
  expect(held.condition).toBe('review_band')
  const failing = decide(flow, s, J('evens', { conf: 0.77, verify: 0.6, phase_done: { evens: 0.97 } }), { evens: FAIL }, 1000)
  expect(failing.kind).toBe(BLOCK)
  // the trust threshold is configurable
  const strict = flowOf({ ...doc, limits: { confidence: { trust_check: 0.99 } } })
  const d = decide(strict, stateOf(strict, 'evens'), J('evens', { conf: 0.77, verify: 0.6, phase_done: { evens: 0.97 } }), { evens: PASS }, 1000)
  expect(d.condition).toBe('review_band')
})

test('applying a goal complete sets done and leaves the budget alone', () => {
  const s = stateOf(linear, 'test', ['scaffold', 'implement'])
  const d = at1060(linear, s, J('test', { verify: 0.9 }), { scaffold: PASS, test: PASS })
  const next = applyDecision(s, d, 1060)
  expect(next.done).toBe(true)
  expect(next.consecutive_blocks).toBe(0)
  expect(next.blocks_this_session).toBe(0)
})

test('consecutive blocks are counted only while the stop hook is active', () => {
  const s = stateOf(linear, 'implement', ['scaffold'], { consecutive_blocks: 3 })
  expect(at1060(linear, s, J('implement'), {}, { stop_hook_active: true }).patch.consecutive_blocks).toBe(4)
  expect(at1060(linear, s, J('implement'), {}, { stop_hook_active: false }).patch.consecutive_blocks).toBe(1)
})

test('the same failure counter climbs to the escalation', () => {
  const s0 = stateOf(linear, 'test', ['scaffold', 'implement'])
  const checks = { scaffold: PASS, test: FAIL }
  let s = s0
  for (const expected of [1, 2, 3]) {
    const d = at1060(linear, s, J('test'), checks)
    expect(d.patch.same_reason_count).toBe(expected)
    s = applyDecision(s, d, 1060)
  }
  expect(at1060(linear, s, J('test'), checks).condition).toBe('stuck_escalate')
})

test('a plain continue repeated over a long phase is not looping', () => {
  let s = stateOf(linear, 'implement', ['scaffold'], { blocks_this_session: 0 })
  for (let i = 0; i < 5; i++) {
    const d = at1060(linear, s, J('implement'), { scaffold: PASS })
    expect(d.condition).toBe('drop_band')
    s = applyDecision(s, d, 1060)
  }
  expect(s.same_reason_count).toBe(0)
})

test('a final phase done while an earlier check has not run blocks instead of asking the person', () => {
  const s = stateOf(linear, 'test', ['scaffold', 'implement'])
  const d = at1060(linear, s, J('test', { verify: 0.9 }), { test: PASS })
  expect([d.kind, d.condition]).toEqual([BLOCK, 'final_check_fail'])
  expect(d.reason).toContain('scaffold')
})

test('the session block budget is the flow limit, not the Claude cap of 8', () => {
  const flow = flowOf({ ...LINEAR, limits: { max_blocks_per_session: 12 } })
  const s = stateOf(flow, 'implement', ['scaffold'], { blocks_this_session: 9 })
  expect(decide(flow, s, J('implement'), { scaffold: PASS }, 1060).kind).toBe(BLOCK)
})

test('a failing check on a branch-only phase is not a regression of the goal', () => {
  const flow = flowOf({
    goal: GOAL,
    phases: [
      { id: 'implement', name: 'I', done_when: 'w', check: 'a', on_fail: 'debug' },
      { id: 'test', name: 'T', done_when: 'w' },
      { id: 'debug', name: 'D', done_when: 'w', check: 'repro', depends_on: [] },
    ],
  })
  const s = stateOf(flow, 'test', ['implement', 'debug'])
  const d = at1060(flow, s, J('test'), { implement: PASS, debug: FAIL })
  expect(d.condition).not.toBe('regression')
})

test('a loop run that fails is counted and reported with its run number', () => {
  const flow = flowOf(LOOPED)
  const s = stateOf(flow, 'test', ['implement'], { loop_iterations: { test: 1 } })
  const d = at1060(flow, s, J('test'), { test: FAIL }, { loop_checks: { test: FAIL } })
  expect(applyDecision(s, d, 1060).loop_iterations.test).toBe(2)
  expect(d.reason).toContain('run 2 of 3 failed')
})

test('ask_human sets needs_human to the question', () => {
  const s = stateOf(linear, 'implement', ['scaffold'])
  const d = at1060(linear, s, J('implement', { next_action: 'ask_human', next_action_conf: 0.9 }), {})
  expect(applyDecision(s, d, 1060).needs_human).toBe(d.question)
})

test('an on_fail route resets the failed phase and activates the branch', () => {
  const flow = flowOf(BRANCH)
  const s = stateOf(flow, 'test', ['implement'])
  const d = at1060(flow, s, J('test', { claims_done: 0.93 }), { test: FAIL })
  const next = applyDecision(s, d, 1060)
  expect(next.current_phase).toBe('debug')
  expect(next.phase_status).toEqual({ implement: 'done', test: 'pending', debug: 'active' })
})

test('the block budget wins over an advance that would otherwise happen', () => {
  const s = stateOf(linear, 'scaffold', [], { blocks_this_session: 6 })
  expect(at1060(linear, s, J('scaffold', { verify: 0.99 }), { scaffold: PASS }).condition).toBe('budget_blocks')
})

test('a branch-only phase is never the next phase', () => {
  const flow = flowOf({
    goal: GOAL,
    phases: [
      { id: 'implement', name: 'Implement', done_when: 'commands work', on_fail: 'debug' },
      { id: 'debug', name: 'Debug', done_when: 'root cause fixed', depends_on: [] },
      { id: 'test', name: 'Tests', done_when: 'suite passes', depends_on: ['implement'] },
    ],
  })
  const d = at1060(flow, stateOf(flow, 'implement'), J('implement', { verify: 0.9 }), {})
  expect([d.condition, d.to_phase]).toEqual(['advance', 'test'])
})

test('review streak: a second review-band stop with a passing check advances', () => {
  let st = stateOf(linear, 'scaffold')
  const step = (j: Judgment, checks: Record<string, CheckResult>): Decision => {
    const d = decide(linear, st, j, checks, 0)
    st = applyDecision(st, d, 0)
    return d
  }
  const d1 = step(J('scaffold', { conf: 0.85, verify: 0.63 }), { scaffold: PASS })
  expect([d1.kind, d1.condition]).toEqual([BLOCK, 'review_band'])
  expect(d1.reason).toContain('its check passes')
  expect(st.review_streak).toEqual({ phase: 'scaffold', n: 1 })
  const d2 = step(J('scaffold', { conf: 0.85, verify: 0.63 }), { scaffold: PASS })
  expect([d2.kind, d2.condition, d2.to_phase]).toEqual([ADVANCE, 'review_check_pass', 'implement'])
  expect(st.review_streak).toBe(null)
})

test('review streak: any other outcome breaks the run and it restarts at one', () => {
  let st = stateOf(linear, 'scaffold')
  const step = (j: Judgment, checks: Record<string, CheckResult>): Decision => {
    const d = decide(linear, st, j, checks, 0)
    st = applyDecision(st, d, 0)
    return d
  }
  step(J('scaffold', { conf: 0.85, verify: 0.63 }), { scaffold: PASS })
  expect(step(J('scaffold', { conf: 0.85, verify: 0.2 }), { scaffold: PASS }).condition).toBe('drop_band')
  expect(st.review_streak).toBe(null)
  expect(step(J('scaffold', { conf: 0.85, verify: 0.63 }), { scaffold: PASS }).condition).toBe('review_band')
})

test('review streak: a review band with no check never advances', () => {
  let st = stateOf(linear, 'implement', ['scaffold'])
  for (let i = 0; i < 4; i++) {
    const d = decide(linear, st, J('implement', { conf: 0.9, verify: 0.65 }), { scaffold: PASS }, 0)
    expect(d.condition).toBe('review_band')
    st = applyDecision(st, d, 0)
  }
  expect(st.review_streak).toBe(null)
})

test('review streak: a review band with a failing check never advances', () => {
  let st = stateOf(linear, 'scaffold')
  for (let i = 0; i < 3; i++) {
    const d = decide(linear, st, J('scaffold', { conf: 0.85, verify: 0.63 }), { scaffold: FAIL }, 0)
    expect(d.kind).not.toBe(ADVANCE)
    st = applyDecision(st, d, 0)
  }
})

// Enforce is the only mode: a block or advance charges the block budget, a question pauses the run.
const BLOCK_D: Decision = {
  kind: BLOCK,
  condition: 'premature_completion',
  reason: 'tests fail',
  notes: [],
  patch: { blocks_inc: 1, consecutive_blocks: 3, stuck_streak: 0 },
}
const ADV_D: Decision = {
  kind: ADVANCE,
  condition: 'advance',
  reason: 'go to b',
  to_phase: 'b',
  notes: [],
  patch: { blocks_inc: 1, consecutive_blocks: 1, phase_status: { a: 'done', b: 'active' }, current_phase: 'b' },
}
const ASK_D: Decision = {
  kind: ALLOW_STOP,
  condition: 'loop_exhausted',
  reason: 'which db?',
  notes: [],
  question: 'which db?',
  patch: { needs_human: 'which db?' },
}

test('enforce: a block charges the block budget and the consecutive run', () => {
  const next = applyDecision(stateOf(linear, 'scaffold', [], { blocks_this_session: 2 }), BLOCK_D, 0)
  expect([next.blocks_this_session, next.consecutive_blocks]).toEqual([3, 3])
})

test('enforce: an advance moves the phase table and charges the block budget', () => {
  const s: FlowState = {
    ...stateOf(linear, 'scaffold'),
    current_phase: 'a',
    phase_status: { a: 'active', b: 'pending' },
    blocks_this_session: 2,
    consecutive_blocks: 1,
  }
  const next = applyDecision(s, ADV_D, 0)
  expect([next.blocks_this_session, next.consecutive_blocks, next.current_phase]).toEqual([3, 1, 'b'])
  expect([next.phase_status.a, next.phase_status.b]).toEqual(['done', 'active'])
})

test('enforce: a question pauses the run and is written to needs_human', () => {
  expect(applyDecision(stateOf(linear, 'implement'), ASK_D, 0).needs_human).toBe('which db?')
  expect(ASK_D.question).toBe('which db?')
})

test('applying a decision leaves its inputs unchanged', () => {
  const before = JSON.stringify([BLOCK_D, ADV_D, ASK_D])
  const s = stateOf(linear, 'scaffold')
  const snapshot = JSON.stringify(s)
  for (const d of [BLOCK_D, ADV_D, ASK_D]) applyDecision(s, d, 0)
  expect(JSON.stringify([BLOCK_D, ADV_D, ASK_D])).toBe(before)
  expect(JSON.stringify(s)).toBe(snapshot)
})

test('the loop message reports the phase check output, not the passing until-check output', () => {
  const flow = flowOf(LOOPED)
  const state = stateOf(flow, 'test', ['implement'])
  const untilOk: CheckResult = { passed: true, output: 'Ran 3 tests\n\nOK' }
  const phaseBad: CheckResult = { passed: false, output: 'no extra test file' }
  const d = at1060(flow, state, J('test'), { implement: PASS, test: phaseBad }, { loop_checks: { test: untilOk } })
  expect(d.condition).toBe('loop_continue')
  expect(d.reason).toContain('no extra test file')
  expect(d.reason).not.toContain('Ran 3 tests')
  expect(d.reason).toContain('phase check fails')
})
