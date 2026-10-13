import { expect, test } from 'claude-code/testing'
import { SPECIALISTS, nativeCodexSpecs } from '../hooks/agents'
import type { Effort, Specialist } from '../hooks/agents'
import type { BindOutcome } from '../hooks/effort'
import type { Routed, Target } from '../hooks/routing'
import { appliedEffort, spawnRequest } from '../hooks/spawn'

// A role on a medium default, so a Jev answer of high is a change from it.
const role = { ...SPECIALISTS.find(s => s.name === 'digger'), effort: 'medium' } as Specialist
const twin: Target = { ...nativeCodexSpecs({ digger: 'gpt-6-luna' })[0] as Target, effort: 'medium', base: 'digger' }
const routedAt = (effort: Effort): Routed => ({ decision: { effort }, ms: 0 })

// Planned effort is high, the role default medium, the bound effort low: each source has its own value.
// [suffix, outcome, bound, requestedApply, expected]
type Outcome = BindOutcome | 'suffix' | undefined
const ROWS: [boolean, Outcome, Effort | undefined, boolean, Effort | null][] = [
  [true, 'applied', undefined, true, 'high'],
  [true, 'applied', undefined, false, 'high'],
  [true, 'applied', 'low', true, 'high'],
  [true, 'applied', 'low', false, 'high'],
  [true, 'matched', undefined, true, 'high'],
  [true, 'matched', undefined, false, 'high'],
  [true, 'matched', 'low', true, 'high'],
  [true, 'matched', 'low', false, 'high'],
  [true, 'suffix', undefined, true, 'high'],
  [true, 'suffix', undefined, false, 'high'],
  [true, 'suffix', 'low', true, 'high'],
  [true, 'suffix', 'low', false, 'high'],
  [true, 'stepped', undefined, true, 'high'],
  [true, 'stepped', undefined, false, 'high'],
  [true, 'stepped', 'low', true, 'high'],
  [true, 'stepped', 'low', false, 'high'],
  [true, undefined, undefined, true, 'high'],
  [true, undefined, undefined, false, 'high'],
  [true, undefined, 'low', true, 'high'],
  [true, undefined, 'low', false, 'high'],
  [false, 'applied', undefined, true, 'high'],
  [false, 'applied', undefined, false, 'high'],
  [false, 'applied', 'low', true, 'low'],
  [false, 'applied', 'low', false, 'low'],
  [false, 'matched', undefined, true, 'high'],
  [false, 'matched', undefined, false, 'high'],
  [false, 'matched', 'low', true, 'low'],
  [false, 'matched', 'low', false, 'low'],
  [false, 'suffix', undefined, true, 'high'],
  [false, 'suffix', undefined, false, 'high'],
  [false, 'suffix', 'low', true, 'low'],
  [false, 'suffix', 'low', false, 'low'],
  [false, 'stepped', undefined, true, null],
  [false, 'stepped', undefined, false, 'medium'],
  [false, 'stepped', 'low', true, 'low'],
  [false, 'stepped', 'low', false, 'low'],
  [false, undefined, undefined, true, null],
  [false, undefined, undefined, false, 'medium'],
  [false, undefined, 'low', true, 'low'],
  [false, undefined, 'low', false, 'low'],
]

test('appliedEffort matches the table for every suffix, outcome, bound and apply policy, as the inline expression did', () => {
  expect(ROWS).toHaveLength(40)
  for (const [suffix, outcome, bound, requestedApply, expected] of ROWS) {
    const applied = appliedEffort({ suffix, outcome, bound, routed: routedAt('high'), requestedApply, spec: { ...role, effort: 'medium' } })
    expect(applied).toBe(expected)
  }
})

test('appliedEffort: an apply request that did not bind is unknown, never a claimed change from the default', () => {
  expect(appliedEffort({ suffix: false, outcome: 'stepped', bound: undefined, routed: routedAt('high'), requestedApply: true, spec: role })).toBeNull()
  expect(appliedEffort({ suffix: false, outcome: 'stepped', bound: undefined, routed: routedAt('high'), requestedApply: false, spec: role })).toBe('medium')
})

test('spawnRequest tags the description with the chosen effort and sends a change as an apply request', () => {
  const request = spawnRequest(role, routedAt('high'), { enabled: true, jevAnswered: true, description: 'fix it' })
  expect(request).toEqual({ description: `fix it · ${role.model}/high`, requestedApply: true, bookEffort: 'high' })
})

test('spawnRequest asks for no apply when Jev answers the role default', () => {
  const request = spawnRequest(role, routedAt('medium'), { enabled: true, jevAnswered: true, description: 'fix it' })
  expect(request).toEqual({ description: `fix it · ${role.model}/medium`, requestedApply: false, bookEffort: 'medium' })
})

test('spawnRequest requests medium on a Jev failure even when medium is the role default', () => {
  const request = spawnRequest(role, routedAt('medium'), { enabled: true, jevAnswered: false, description: 'fix it' })
  expect(request.requestedApply).toBe(true)
  expect(request.bookEffort).toBe('medium')
})

test('spawnRequest sends a twin with its suffix only, and asks for no apply when routing is off and the effort is the default', () => {
  const request = spawnRequest(twin, routedAt('medium'), { enabled: false, jevAnswered: false, description: 'fix it' })
  expect(request).toEqual({ description: 'fix it · gpt-6-luna/medium', suffix: 'cx/gpt-6-luna-medium', requestedApply: false, bookEffort: 'medium' })
})

test('spawnRequest gives a twin a Jev change as its suffix effort and as the book effort', () => {
  const request = spawnRequest(twin, routedAt('high'), { enabled: true, jevAnswered: true, description: 'fix it' })
  expect(request).toEqual({ description: 'fix it · gpt-6-luna/high', suffix: 'cx/gpt-6-luna-high', requestedApply: true, bookEffort: 'high' })
})
