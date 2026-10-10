import { expect, test } from 'claude-code/testing'
import { branchOnly, checksToRun, requiredPhases, slugify, summaryMarkdown, utcStamp } from '../hooks/jevflow/project'
import type { StateView } from '../hooks/jevflow/project'
import type { Flow, Limits, Phase } from '../hooks/jevflow/types'

// Ported from JevFlow's tests: test_hooks (which checks run), test_auto (SUMMARY.md content).

const LIMITS: Limits = {
  max_blocks_per_session: 6, max_restarts: 5, max_total_minutes: 90, hang_minutes: 10, max_jev_calls: 200,
  check_timeout_s: 120, state_char_budget: 12000, confidence: { auto: 0.8, review: 0.5, flag: 0.7, trust_check: 0.9 },
}
const phase = (id: string, extra: Partial<Phase> = {}): Phase => ({
  id, name: `Make ${id}`, done_when: `${id} exists`, depends_on: [], side_effect: false, ...extra,
})
const flowOf = (phases: Phase[], extra: Partial<Flow> = {}): Flow => ({
  goal: 'Toy goal', title: '', schema_version: 1, flow_version: '1', phases,
  limits: LIMITS, privacy: { send_diff: false }, ...extra,
})

test('slugify keeps the first meaningful words, lowercase and dash-joined', () => {
  expect(slugify('Add a --verbose flag to the CLI, cover it with tests and document it in the README')).toBe('add-verbose-flag-cli-cover')
  expect(slugify('Please add the dark mode toggle', 6)).toBe('add-dark-mode-toggle')
})

test('slugify falls back to flow when nothing is left, and cuts at 48 characters without a trailing dash', () => {
  expect(slugify('Please!!!')).toBe('flow')
  expect(slugify('')).toBe('flow')
  expect(slugify('a'.repeat(60))).toBe('a'.repeat(48))
  expect(slugify('abcdefghijk abcdefghijk abcdefghijk abcdefghijk abcdefghijk')).toBe(
    'abcdefghijk-abcdefghijk-abcdefghijk-abcdefghijk',
  )
})

test('branch-only phases are the on_fail targets nobody depends on, and are left out of the required phases', () => {
  const flow = flowOf([phase('a', { on_fail: 'dbg' }), phase('b', { depends_on: ['a'] }), phase('dbg')])
  expect(Array.from(branchOnly(flow))).toEqual(['dbg'])
  expect(requiredPhases(flow)).toEqual(['a', 'b'])
  const depended = flowOf([phase('a', { on_fail: 'b' }), phase('b', { depends_on: ['a'] }), phase('c', { depends_on: ['b'] })])
  expect(Array.from(branchOnly(depended))).toEqual([])
  expect(requiredPhases(depended)).toEqual(['a', 'b', 'c'])
})

const withDbg = (): Flow => flowOf([
  phase('a', { check: 'true' }),
  phase('b', { check: 'true', on_fail: 'dbg' }),
  phase('c', { check: 'true' }),
  phase('dbg', { check: 'true' }),
])

test('checks run for the current phase and the done phases, never for branch-only ones', () => {
  const state: StateView = { current_phase: 'b', phase_status: { a: 'done', b: 'active', c: 'pending', dbg: 'done' } }
  expect(checksToRun(withDbg(), state)).toEqual(['a', 'b'])
})

test('while settling, pending phases with a check run too, except loops, side effects and branch-only phases', () => {
  const flow = flowOf([
    phase('a', { check: 'true' }),
    phase('b', { check: 'true', on_fail: 'dbg' }),
    phase('c', { check: 'true' }),
    phase('d', { check: 'true', loop: { max_iterations: 2, until: 'true' } }),
    phase('e', { check: 'true', side_effect: true }),
    phase('f'),
    phase('dbg', { check: 'true' }),
  ])
  const state: StateView = { current_phase: 'a', phase_status: { a: 'active' } }
  expect(checksToRun(flow, state)).toEqual(['a'])
  expect(checksToRun(flow, state, true)).toEqual(['a', 'b', 'c'])
})

test('the summary records the outcome, timing, stop decisions and the phase table', () => {
  const flow = flowOf([phase('build', { done_when: 'it works' })])
  const state: StateView = {
    started_at: 1000000, jev_calls: 2, restarts: 0, phase_status: { build: 'done' },
    history: [
      { event: 'stop', decision: 'BLOCK' },
      { event: 'stop', decision: 'ALLOW_STOP' },
      { event: 'stop', decision: 'BLOCK' },
      { event: 'other' },
    ],
  }
  const md = summaryMarkdown({ flowId: '20261010-toy', flow, state, draft: { goal: 'draft goal', created_at: 1 }, now: 1000600, outcome: 'complete' })
  expect(md).toBe([
    '# 20261010-toy', '', 'Outcome: **complete**', '', 'Goal: Toy goal', '',
    'Started 1970-01-12 13:46:40Z, archived 1970-01-12 13:56:40Z (10.0 min).',
    'Jev calls: 2. Restarts: 0. Stops: ALLOW_STOP 1, BLOCK 2.', '',
    '| Phase | Status | Done when |', '| --- | --- | --- |', '| build | done | it works |', '',
  ].join('\n'))
})

test('the summary falls back to the draft goal, says none when no stop was recorded, and escapes pipes in done_when', () => {
  const flow = flowOf([phase('build', { done_when: 'a | b' })], { goal: '' })
  const md = summaryMarkdown({
    flowId: 'toy', flow, state: {}, draft: { goal: 'draft goal', created_at: 1000000 }, now: 1000000, outcome: 'abandoned',
  })
  expect(md).toContain('Goal: draft goal\n')
  expect(md).toContain('Jev calls: 0. Restarts: 0. Stops: none.')
  expect(md).toContain('| build | pending | a / b |')
})

test('utcStamp formats epoch seconds in UTC and reads an invalid time as ?', () => {
  expect(utcStamp(0)).toBe('1970-01-01 00:00:00Z')
  expect(utcStamp(1000000)).toBe('1970-01-12 13:46:40Z')
  expect(utcStamp(Number.NaN)).toBe('?')
})
