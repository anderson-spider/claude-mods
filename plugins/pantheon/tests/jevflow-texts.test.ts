import { expect, test } from 'claude-code/testing'
import {
  claimInstruction, goalFromConversationPrompt, goalPrompt, idempotencyKey, phaseTable, planInstructions, render,
  sessionContext, transitionLine,
} from '../hooks/jevflow/texts'
import type { StateView } from '../hooks/jevflow/project'
import type { Flow, Limits, Phase } from '../hooks/jevflow/types'

// Ported from JevFlow's tests: test_hooks (session context, status), test_regions (idempotency key),
// test_multi (transition line), test_auto (task filter), test_v020 (first-prompt nudge).

const LIMITS: Limits = {
  max_blocks_per_session: 6, max_restarts: 5, max_total_minutes: 90, hang_minutes: 10, max_jev_calls: 200,
  check_timeout_s: 120, state_char_budget: 12000, confidence: { auto: 0.8, review: 0.5, flag: 0.7, trust_check: 0.9 },
}
const phase = (id: string, extra: Partial<Phase> = {}): Phase => ({
  id, name: `Make ${id}`, done_when: `${id} exists`, depends_on: [], side_effect: false, ...extra,
})
const flowOf = (phases: Phase[], extra: Partial<Flow> = {}): Flow => ({
  goal: 'Toy: create a.txt then b.txt', title: '', schema_version: 1, flow_version: '1', phases,
  limits: LIMITS, privacy: { send_diff: false }, ...extra,
})
const twoPhase = (): Flow => flowOf([
  phase('a', { check: 'test -f a.txt', done_when: 'a.txt exists' }),
  phase('b', { check: 'test -f b.txt', done_when: 'b.txt exists' }),
])
const STOP = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: 'stop', decision: 'BLOCK', condition: 'degraded_check_fail', phase: 'a',
  reason: 'Phase a: a.txt is missing', ts: 1000000, enforced: true, ...over,
})

// --- session context (hooks.py session_context) ---

test('session context opens with the flow, its phases and the current phase with its check', () => {
  const state: StateView = { current_phase: 'a', phase_status: { a: 'active', b: 'pending' } }
  const ctx = sessionContext(twoPhase(), state, 'startup')
  expect(ctx.startsWith('The Pantheon flow is tracking this session against a declared flow. A Stop hook checks progress before you are allowed to stop.\n\nGoal: Toy: create a.txt then b.txt\n\nPhases:\n> [active] a: Make a\n  [pending] b: Make b')).toBe(true)
  expect(ctx).toContain('Current phase: a (Make a). Done when: a.txt exists. Check: `test -f a.txt`.')
  expect(ctx).not.toContain('Last flow instruction')
})

test('the last block reason comes back on resume and compact only, cut to 1500 characters', () => {
  const marker = 'Last flow instruction before this point:\n'
  const state: StateView = { current_phase: 'a', phase_status: { a: 'active' }, last_block_reason: 'X'.repeat(5000) }
  expect(sessionContext(twoPhase(), state, 'startup')).not.toContain(marker)
  for (const source of ['resume', 'compact']) {
    const ctx = sessionContext(twoPhase(), state, source)
    const shown = ctx.slice(ctx.indexOf(marker) + marker.length)
    expect(shown.length).toBe(1500)
    expect(shown.endsWith('...')).toBe(true)
  }
  const short: StateView = { ...state, last_block_reason: 'Continue phase a please' }
  expect(sessionContext(twoPhase(), short, 'resume')).toContain(`${marker}Continue phase a please`)
})

test("a pending human decision is named with the flow's NEEDS_HUMAN path", () => {
  const ctx = sessionContext(twoPhase(), { current_phase: 'a', phase_status: {}, needs_human: 'Which database?' }, 'startup', '.pantheon/flow/flows/x/NEEDS_HUMAN.md')
  expect(ctx).toContain('A human decision is pending (see .pantheon/flow/flows/x/NEEDS_HUMAN.md): Which database?')
})

test('a finished goal says so and names no current phase', () => {
  const state: StateView = { current_phase: 'b', phase_status: { a: 'done', b: 'done' }, done: true }
  const ctx = sessionContext(twoPhase(), state, 'startup')
  expect(ctx).toContain('The goal is already complete.')
  expect(ctx).not.toContain('Current phase:')
})

// --- side effects and idempotency keys (regions.py idempotency_key) ---

const sideFlow = (): Flow => flowOf([
  phase('build', { check: 'test -f built.txt' }),
  phase('publish', { depends_on: ['build'], side_effect: true, check: 'test -f pub.txt' }),
])

test('a side-effect phase carries its idempotency key, and finished ones are listed as never to repeat', () => {
  const pending = sessionContext(sideFlow(), { current_phase: 'publish', phase_status: { build: 'done', publish: 'active' } }, 'resume')
  expect(pending).toContain('This phase has an external side effect. Idempotency key: `1:publish:1`. A previous session may have done it before stopping, so check first and pass the key to the action if it accepts one. Do it at most once.')
  expect(pending).not.toContain('Side effects already performed')
  const again = sessionContext(sideFlow(), { current_phase: 'publish', phase_status: { build: 'done', publish: 'done' }, phase_attempts: { publish: 2 } }, 'startup')
  expect(again).toContain('Side effects already performed, never repeat them: publish (1:publish:2)')
})

test('the idempotency key uses the flow version and the phase attempt, 1 when the attempt is not a whole number of at least 1', () => {
  expect(idempotencyKey(sideFlow(), {}, 'publish')).toBe('1:publish:1')
  expect(idempotencyKey(sideFlow(), { phase_attempts: { publish: 3 } }, 'publish')).toBe('1:publish:3')
  expect(idempotencyKey(sideFlow(), { phase_attempts: { publish: 0 } }, 'publish')).toBe('1:publish:1')
  expect(idempotencyKey({ ...sideFlow(), flow_version: '7' }, {}, 'publish')).toBe('7:publish:1')
})

// --- phase table (hooks.py phase_table) ---

test('the phase table marks the current phase and annotates dependencies, loops, failure routes and side effects', () => {
  const flow = flowOf([
    phase('a', { on_fail: 'dbg' }),
    phase('b', { depends_on: ['a'], loop: { max_iterations: 3, until: 'make check' }, side_effect: true }),
    phase('dbg'),
  ])
  expect(phaseTable(flow, { current_phase: 'b', phase_status: { a: 'done', b: 'active' } })).toBe([
    '  [done] a: Make a (on_fail->dbg)',
    '> [active] b: Make b (after a; loop<= 3 until `make check`; side effect)',
    '  [pending] dbg: Make dbg (branch only)',
  ].join('\n'))
})

// --- transition line (hooks.py transition_line) ---

test('the transition line names the flow, the step, the done count and the first sentence of the reason', () => {
  const state: StateView = { current_phase: 'b', phase_status: { a: 'done', b: 'active' } }
  expect(transitionLine({ ...twoPhase(), title: 'Toy files' }, state, { reason: "Phase 'a' is complete.", to_phase: 'b' }, 'a'))
    .toBe("[Pantheon flow] Toy files: ✓ a → b (1/2 done) · Phase 'a' is complete.")
  expect(transitionLine(twoPhase(), state, { reason: 'Phase a is complete. Moving on.\nmore', to_phase: 'b' }))
    .toBe('[Pantheon flow] → b (1/2 done) · Phase a is complete.')
})

test('the transition line adds the period when the reason has none and drops a repeated step arrow', () => {
  const state: StateView = { current_phase: 'a', phase_status: { a: 'active', b: 'pending' } }
  expect(transitionLine(twoPhase(), state, { reason: 'Phase a is ready', to_phase: 'a' }, 'a'))
    .toBe('[Pantheon flow] → a (0/2 done) · Phase a is ready.')
})

// --- planning instructions (auto.py) ---

test('the planning instructions point at .pantheon/flow/flow.json and carry the example without a mode', () => {
  const text = planInstructions('.pantheon/flow/flows/x/flow.json', 'x', 'Add a dark mode toggle')
  expect(text).toContain('starts a tracked flow `x`.')
  expect(text).toContain('lay it out as phases by writing `.pantheon/flow/flows/x/flow.json`:')
  expect(text).toContain('"goal": "Add a dark mode toggle"')
  expect(text).not.toContain('"mode"')
  expect(text).toContain('by calling the `mcp__pantheon__flow` tool with `action: "validate"`')
  expect(text).toContain('start the Agent description with `[<phase id>]` (for example `[docs] Update the README`)')
  expect(text).toContain('you claim your own phase with the tool.')
  expect(text).toContain('Do not edit other files under `.pantheon/flow/`.')
  expect(text).not.toContain('.jevflow')
  expect(text).not.toContain('jevflow validate')
})

test('the example goal is cut to 200 characters with an ellipsis', () => {
  expect(planInstructions('f.json', 'x', 'g'.repeat(250))).toContain(`"goal": "${'g'.repeat(200)}..."`)
  expect(planInstructions('f.json', 'x', 'g'.repeat(200))).toContain(`"goal": "${'g'.repeat(200)}",`)
})

test('the goal prompt carries the planning instructions and the brainstorm line', () => {
  const text = goalPrompt('PLANNING')
  expect(text).toContain('[Pantheon flow] The person started a flow with /pantheon goal.')
  expect(text).toContain('PLANNING')
  expect(text).toContain('If a brainstorm defined the idea in this conversation, turn its decisions into the phases and their checks.')
})

test('the conversation prompt asks for the start action with the defined idea, and a question when none is defined', () => {
  const text = goalFromConversationPrompt()
  expect(text).toContain('`mcp__pantheon__flow` tool with `action: "start"`')
  expect(text).toContain('`goal` set to the defined idea')
  expect(text).toContain('`name` set to a short kebab-case name')
  expect(text).toContain('ask the person for the goal in one question and stop')
  expect(text).not.toContain('jevflow')
})

test('the claim sentence names the claim action, the phase and the Pantheon roles', () => {
  const text = claimInstruction()
  expect(text).toContain('`action: "claim"`')
  expect(text).toContain('`as: "<your role>"`')
  for (const role of ['lead', 'code-reader', 'docs-reader', 'developer', 'ux', 'architect', 'qa']) {
    expect(text).toContain(`\`${role}\``)
  }
})

// --- status (status.py render) ---

test('status shows the phase table, the budgets, the start time and the recent stop decisions', () => {
  const state: StateView = {
    current_phase: 'a', phase_status: { a: 'active', b: 'pending' }, blocks_this_session: 1, started_at: 1000000,
    agents: { s1: { label: 'claude a1b2c3', kind: 'session', session: 's1', phase: 'a', first_at: 0, at: 0, tools: 0, stops: 0 } },
    history: [STOP()],
  }
  const out = render(twoPhase(), state)
  expect(out).toMatch(/PHASE\s+STATUS\s+CHECK\s+AGENTS\s+NOTES/)
  expect(out).toMatch(/>\s+a\s+active\s+yes\s+claude a1b2c3/)
  expect(out).toMatch(/\n\s+b\s+pending\s+yes/)
  expect(out).toContain('Goal: Toy: create a.txt then b.txt')
  expect(out).toContain('Flow version 1. Done: no.')
  expect(out).toContain('Blocks this session: 1/6  Restarts: 0/5  Jev calls: 0/200  Started: 1970-01-12 13:46:40Z')
  expect(out).toContain('1970-01-12 13:46:40Z  BLOCK/degraded_check_fail  [a] Phase a: a.txt is missing')
  expect(out).not.toContain('NEEDS_HUMAN')
})

test('status with no stop yet says so, and shows the flow title when there is one', () => {
  const out = render({ ...twoPhase(), title: 'Toy files' }, { current_phase: 'a', phase_status: {} })
  expect(out.startsWith('Flow: Toy files\nGoal: Toy: create a.txt then b.txt')).toBe(true)
  expect(out).toContain('Recent decisions:\n  (none yet)')
  expect(out).toContain('Started: ?')
})

test('status adds the last errors, the NEEDS_HUMAN text and flags unenforced stops', () => {
  const state: StateView = {
    current_phase: 'a', phase_status: { a: 'active' }, needs_human: 'Which database?',
    last_error: { error: 'overloaded', ts: 1000000 }, last_jev_error: { error: 'timeout', ts: 1000000 },
    history: [STOP({ enforced: false }), STOP({ decision: 'ALLOW_STOP', condition: 'ok', enforced: false })],
  }
  const out = render(twoPhase(), state, '# Jevflow needs a human\n\nPick one.\n')
  expect(out).toContain('Last Claude API error: overloaded at 1970-01-12 13:46:40Z')
  expect(out).toContain('Last Jev error (checks-only fallback): timeout at 1970-01-12 13:46:40Z')
  expect(out).toContain('BLOCK/degraded_check_fail (not enforced)  [a]')
  expect(out).toContain('ALLOW_STOP/ok  [a]')
  expect(out).not.toContain('ALLOW_STOP/ok (not enforced)')
  expect(out).toContain('NEEDS_HUMAN:\n# Jevflow needs a human\n\nPick one.')
})

test('without the NEEDS_HUMAN file the status shows the state value under the heading', () => {
  const out = render(twoPhase(), { current_phase: 'a', phase_status: {}, needs_human: 'Which database?' })
  expect(out.endsWith('NEEDS_HUMAN:\n  Which database?')).toBe(true)
})

test('a long stop reason is cut to 107 characters and an ellipsis, and newlines become spaces', () => {
  const state: StateView = { current_phase: 'a', phase_status: {}, history: [STOP({ reason: `line one\n${'y'.repeat(150)}` })] }
  const line = render(twoPhase(), state).split('\n').find(l => l.includes('BLOCK/degraded_check_fail'))
  expect(line).toContain(`[a] line one ${'y'.repeat(98)}...`)
  expect(line).not.toContain('y'.repeat(99))
})

test('status lists only the most recent stop decisions', () => {
  const history = Array.from({ length: 10 }, (_, i) => STOP({ reason: `step-${i}` }))
  const out = render(twoPhase(), { current_phase: 'a', phase_status: {}, history })
  expect(out).toContain('step-9')
  expect(out).toContain('step-2')
  expect(out).not.toContain('step-1')
  expect(render(twoPhase(), { current_phase: 'a', phase_status: {}, history }, null, 3)).not.toContain('step-6')
})
