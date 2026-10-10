import { expect, test } from 'claude-code/testing'
import { flowHash, validateFlow } from '../hooks/flow/plan'
import type { Flow } from '../hooks/flow/plan'
import { applyMode, decide, enterEnforce, newState, OUTPUT_TAIL, rebase, withMode } from '../hooks/flow/policy'
import type { CheckResult, FlowEvent, FlowState, Judgment } from '../hooks/flow/types'

type Raw = Record<string, unknown>
const check = (name = 't') => ({ argv: ['run', name] })
const task = (id: string, extra: Raw = {}): Raw => ({ id, goal: `goal ${id}`, files: [`src/${id}.ts`], acceptance: { checks: [check(id)] }, ...extra })
const build = (tasks: Raw[], limits?: Raw): { flow: Flow; hash: string } => {
  const result = validateFlow({ schemaVersion: 1, planId: 'p', goal: 'g', ...(limits ? { limits } : {}), tasks })
  if (!result.ok) throw new Error(result.errors.join('; '))
  return { flow: result.flow, hash: result.hash }
}

// A chain: A, then B (risky), then C (criteria only).
const chain = () => build([task('A'), task('B', { risk: true }), task('C', { acceptance: { criteria: ['reads well'] } })])
const approved = (flow: Flow, hash: string, patch: Partial<FlowState> = {}): FlowState => ({ ...newState(flow, hash), approvedHash: hash, ...patch })

const pass = (name = 't'): CheckResult => ({ argv: ['run', name], passed: true, output: '' })
const fail = (name = 't', output = 'boom'): CheckResult => ({ argv: ['run', name], passed: false, output })
const stopEvent = (checks: Record<string, CheckResult[]> = {}, extra: Partial<Extract<FlowEvent, { kind: 'stop' }>> = {}): FlowEvent =>
  ({ kind: 'stop', stopHookActive: false, backgroundTasks: 0, runningAgents: 0, checks, ...extra })
const endEvent = (taskId: string, checks: CheckResult[], ownershipDenials = 0): FlowEvent => ({ kind: 'taskEnd', taskId, checks, ownershipDenials })

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

// --- newState ---

test('newState activates the first eligible task and leaves the rest pending', () => {
  const { flow, hash } = chain()
  const state = newState(flow, hash)
  expect(state.status).toEqual({ A: 'active', B: 'pending', C: 'pending' })
  expect(state).toMatchObject({ planId: 'p', hash, blocks: 0, consecutiveBlocks: 0, paused: false, stopped: false, done: false, reviewed: [], sideEffectsDone: [] })
  expect(state.approvedHash).toBeUndefined()
})

test('fan-out roots: the first listed eligible task starts and the join waits for both', () => {
  const { flow, hash } = build([task('cli', { dependsOn: [] }), task('docs', { dependsOn: [] }), task('final', { dependsOn: ['cli', 'docs'] })])
  const state = approved(flow, hash)
  expect(state.status).toEqual({ cli: 'active', docs: 'pending', final: 'pending' })
  const first = decide(flow, state, endEvent('cli', [pass('cli')]))
  expect(first).toMatchObject({ action: 'advance', condition: 'task_done', task: 'docs' })
  expect(first.state.status).toEqual({ cli: 'done', docs: 'active', final: 'pending' })
  const second = decide(flow, first.state, endEvent('docs', [pass('docs')]))
  expect(second).toMatchObject({ action: 'advance', task: 'final' })
  // Finishing the last task never completes the flow: the Stop that follows sees every check.
  const last = decide(flow, second.state, endEvent('final', [pass('final')]))
  expect(last).toMatchObject({ action: 'advance', condition: 'all_done' })
  expect(last.state.done).toBe(false)
  const verified = decide(flow, last.state, stopEvent({ cli: [pass('cli')], docs: [pass('docs')], final: [pass('final')] }))
  expect(verified).toMatchObject({ action: 'complete', condition: 'complete' })
  expect(verified.state.done).toBe(true)
})

// --- stop: precedence and conditions ---

test('stop with nothing to enforce allows and resets the consecutive run', () => {
  const { flow, hash } = chain()
  const cases: [string, FlowState][] = [
    ['already_done', approved(flow, hash, { done: true, consecutiveBlocks: 3 })],
    ['paused', approved(flow, hash, { paused: true, consecutiveBlocks: 3 })],
    ['stopped', approved(flow, hash, { stopped: true, consecutiveBlocks: 3 })],
  ]
  for (const [condition, state] of cases) {
    const decision = decide(flow, state, stopEvent({ A: [fail('A')] }, { stopHookActive: true }))
    expect(decision).toMatchObject({ action: 'allow', condition })
    expect(decision.state.consecutiveBlocks).toBe(0)
    expect(decision.state.blocks).toBe(state.blocks)
  }
})

test('an unapproved or edited flow is allowed with the state exactly as it was', () => {
  const { flow, hash } = chain()
  const cases: FlowState[] = [
    { ...newState(flow, hash), blocks: 2, consecutiveBlocks: 3 },
    { ...newState(flow, hash), approvedHash: 'other', blocks: 2, consecutiveBlocks: 3 },
    // Approved, but the plan was edited afterwards: the state still carries the old hash.
    { ...newState(flow, 'old'), approvedHash: 'old', blocks: 2, consecutiveBlocks: 3 },
    // The state was rebased to the new hash but not approved again.
    { ...newState(flow, hash), approvedHash: 'old', blocks: 2, consecutiveBlocks: 3 },
  ]
  for (const state of cases) {
    for (const event of [stopEvent({ A: [fail('A')] }, { stopHookActive: true }), endEvent('A', [fail('A')])]) {
      const decision = decide(flow, state, event)
      expect(decision).toMatchObject({ action: 'allow', condition: 'unapproved' })
      expect(decision.state).toEqual(state)
    }
  }
})

test('a task end on a done, paused or stopped flow is allowed untouched', () => {
  const { flow, hash } = chain()
  const cases: [string, Partial<FlowState>][] = [['already_done', { done: true }], ['paused', { paused: true }], ['stopped', { stopped: true }]]
  for (const [condition, patch] of cases) {
    const state = approved(flow, hash, { ...patch, blocks: 1 })
    const decision = decide(flow, state, endEvent('A', [fail('A')]))
    expect(decision).toMatchObject({ action: 'allow', condition })
    expect(decision.state).toEqual(state)
  }
})

test('unapproved wins over done, paused and stopped', () => {
  const { flow, hash } = chain()
  const state: FlowState = { ...newState(flow, hash), done: true, paused: true, stopped: true }
  expect(decide(flow, state, stopEvent()).condition).toBe('unapproved')
})

test('background work waits without spending budget', () => {
  const { flow, hash } = chain()
  for (const extra of [{ backgroundTasks: 1 }, { runningAgents: 2 }]) {
    const state = approved(flow, hash, { blocks: 2, consecutiveBlocks: 2 })
    const decision = decide(flow, state, stopEvent({ A: [fail('A')] }, { stopHookActive: true, ...extra }))
    expect(decision).toMatchObject({ action: 'wait', condition: 'waiting' })
    expect(decision.state.blocks).toBe(2)
    expect(decision.state.consecutiveBlocks).toBe(0)
  }
})

test('waiting outranks the budget', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { blocks: 6 })
  expect(decide(flow, state, stopEvent({}, { backgroundTasks: 1 })).condition).toBe('waiting')
})

test('budget by blocks settles by checks, then allows with what is still open', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { blocks: 6 })
  const decision = decide(flow, state, stopEvent({ A: [pass('A')], B: [fail('B')] }))
  expect(decision).toMatchObject({ action: 'allow', condition: 'budget' })
  expect(decision.state.status).toEqual({ A: 'done', B: 'active', C: 'pending' })
  expect(decision.state.blocks).toBe(6)
  expect(decision.state.consecutiveBlocks).toBe(0)
  expect(decision.reason).toContain('A')
  expect(decision.reason).toContain('Still open: B, C')
})

test('budget by the consecutive cap only applies while the stop hook is active', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { blocks: 3, consecutiveBlocks: 7 })
  expect(decide(flow, state, stopEvent({}, { stopHookActive: true }))).toMatchObject({ action: 'allow', condition: 'budget' })
  // A Stop that does not follow one of our blocks starts the run over.
  const fresh = decide(flow, state, stopEvent({}, { stopHookActive: false }))
  expect(fresh.action).toBe('block')
  expect(fresh.state.consecutiveBlocks).toBe(1)
})

test('budget uses maxBlocks from the flow', () => {
  const { flow, hash } = build([task('A')], { maxBlocks: 2 })
  expect(decide(flow, approved(flow, hash, { blocks: 1 }), stopEvent()).action).toBe('block')
  expect(decide(flow, approved(flow, hash, { blocks: 2 }), stopEvent()).condition).toBe('budget')
})

test('budget settling every required task ends complete', () => {
  const { flow, hash } = build([task('A'), task('B')])
  const decision = decide(flow, approved(flow, hash, { blocks: 6 }), stopEvent({ A: [pass('A')], B: [pass('B')] }))
  expect(decision).toMatchObject({ action: 'allow', condition: 'complete' })
  expect(decision.state.done).toBe(true)
  expect(decision.state.status).toEqual({ A: 'done', B: 'done' })
})

test('settling never marks a side-effect or a check-less task done', () => {
  const { flow, hash } = build([task('A', { sideEffect: true }), task('B', { acceptance: { criteria: ['x'] }, dependsOn: [] })])
  const decision = decide(flow, approved(flow, hash, { blocks: 6 }), stopEvent({ A: [pass('A')] }))
  expect(decision.condition).toBe('budget')
  expect(decision.state.status.A).not.toBe('done')
  expect(decision.state.status.B).not.toBe('done')
})

test('regression blocks back to the done task and re-opens its review', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, reviewed: ['A'], awaitingReview: ['B'], attempts: { A: 2 } })
  const decision = decide(flow, state, stopEvent({ A: [fail('A', 'A broke')], B: [pass('B')] }))
  expect(decision).toMatchObject({ action: 'block', condition: 'regression', task: 'A' })
  expect(decision.reason).toContain('A broke')
  expect(decision.reason).toContain('[A]')
  expect(decision.state.status).toEqual({ A: 'active', B: 'pending', C: 'pending' })
  expect(decision.state.attempts.A).toBeUndefined()
  expect(decision.state.reviewed).toEqual([])
  expect(decision.state.awaitingReview).toEqual([])
  expect(decision.state.blocks).toBe(1)
  expect(decision.state.consecutiveBlocks).toBe(1)
  expect(decision.state.lastInstruction).toBe(decision.reason)
})

test('a regression only sends back work that depends on the broken task', () => {
  const { flow, hash } = build([task('A', { dependsOn: [] }), task('X', { dependsOn: [] }), task('B', { dependsOn: ['A'] })])
  const state = approved(flow, hash, { status: { A: 'done', X: 'active', B: 'active' } })
  const decision = decide(flow, state, stopEvent({ A: [fail('A')] }))
  expect(decision.condition).toBe('regression')
  expect(decision.state.status).toEqual({ A: 'active', X: 'active', B: 'pending' })
})

test('a regression in a side-effect task pauses and never re-enters it', () => {
  const { flow, hash } = build([task('A', { sideEffect: true }), task('B')])
  const state = approved(flow, hash, { status: { A: 'done', B: 'active' }, sideEffectsDone: ['A'] })
  const decision = decide(flow, state, stopEvent({ A: [fail('A', 'drift')] }))
  expect(decision).toMatchObject({ action: 'pause', condition: 'side_effect_regression', task: 'A' })
  expect(decision.state.status.A).toBe('done')
  expect(decision.state.paused).toBe(true)
  expect(decision.state.blocks).toBe(0)
  expect(decision.reason).toContain('drift')
})

test('a done branch-only onFail target is not a standing invariant', () => {
  const { flow, hash } = build([task('A', { onFail: 'DEBUG' }), task('DEBUG', { dependsOn: [] })])
  const state = approved(flow, hash, { status: { A: 'active', DEBUG: 'done' } })
  const decision = decide(flow, state, stopEvent({ DEBUG: [fail('DEBUG')] }))
  expect(decision.condition).not.toBe('regression')
})

test('a failing active check blocks with the output tail, named by task', () => {
  const { flow, hash } = chain()
  const long = 'x'.repeat(5000) + 'THE-END'
  const decision = decide(flow, approved(flow, hash), stopEvent({ A: [fail('A', long)] }))
  expect(decision).toMatchObject({ action: 'block', condition: 'check_failed', task: 'A' })
  expect(decision.reason).toContain('Task A')
  expect(decision.reason).toContain('THE-END')
  expect(decision.reason.length).toBeLessThan(OUTPUT_TAIL + 300)
  expect(decision.reason).toContain('...')
  expect(decision.state.blocks).toBe(1)
  expect(decision.state.consecutiveBlocks).toBe(1)
  expect(decision.state.lastInstruction).toBe(decision.reason)
})

test('a check that could not run counts as failing and says so', () => {
  const { flow, hash } = chain()
  const decision = decide(flow, approved(flow, hash), stopEvent({ A: [{ argv: ['run', 'A'], passed: null, output: 'ENOENT' }] }))
  expect(decision).toMatchObject({ action: 'block', condition: 'check_failed' })
  expect(decision.reason).toContain('could not run')
  expect(decision.reason).toContain('ENOENT')
})

test('the third identical failure pauses and asks; a different output starts over', () => {
  const { flow, hash } = chain()
  let state = approved(flow, hash)
  const first = decide(flow, state, stopEvent({ A: [fail('A', 'same')] }, { stopHookActive: true }))
  expect(first.condition).toBe('check_failed')
  expect(first.state.lastFailure?.count).toBe(1)
  const second = decide(flow, first.state, stopEvent({ A: [fail('A', 'same')] }, { stopHookActive: true }))
  expect(second.condition).toBe('check_failed')
  expect(second.state.lastFailure?.count).toBe(2)
  const third = decide(flow, second.state, stopEvent({ A: [fail('A', 'same')] }, { stopHookActive: true }))
  expect(third).toMatchObject({ action: 'pause', condition: 'looping', task: 'A' })
  expect(third.state.paused).toBe(true)
  expect(third.state.blocks).toBe(2)
  expect(third.state.consecutiveBlocks).toBe(0)

  state = second.state
  const other = decide(flow, state, stopEvent({ A: [fail('A', 'different')] }, { stopHookActive: true }))
  expect(other.condition).toBe('check_failed')
  expect(other.state.lastFailure?.count).toBe(1)
})

test('a passing stop clears the failure streak', () => {
  const { flow, hash } = chain()
  const failing = decide(flow, approved(flow, hash), stopEvent({ A: [fail('A', 'same')] }))
  const passing = decide(flow, failing.state, stopEvent({ A: [pass('A')] }))
  expect(passing.condition).toBe('continue')
  expect(passing.state.lastFailure).toBeUndefined()
})

test('a risky task awaiting review blocks the stop asking for the oracle', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaitingReview: ['B'] })
  const decision = decide(flow, state, stopEvent({ A: [pass('A')], B: [pass('B')] }))
  expect(decision).toMatchObject({ action: 'block', condition: 'review_needed', task: 'B' })
  expect(decision.reason).toContain('oracle')
  expect(decision.state.blocks).toBe(1)
})

test('an active risky task that has not passed its checks yet just continues', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' } })
  expect(decide(flow, state, stopEvent({ A: [pass('A')] })).condition).toBe('continue')
  expect(decide(flow, state, stopEvent({ A: [pass('A')], B: [pass('B')] })).condition).toBe('continue')
})

test('checks that fail while a review is pending drop the task from awaitingReview', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaitingReview: ['B'] })
  const decision = decide(flow, state, stopEvent({ A: [pass('A')], B: [fail('B')] }))
  expect(decision.condition).toBe('check_failed')
  expect(decision.state.awaitingReview).toEqual([])
})

test('completion needs a passing result for every declared check of every required task', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'done', C: 'done' }, blocks: 2, consecutiveBlocks: 2 })
  const nullResult: CheckResult = { argv: ['run', 'B'], passed: null, output: 'timeout' }
  for (const checks of [{ A: [pass('A')] }, { A: [pass('A')], B: [nullResult] }, {}]) {
    const decision = decide(flow, state, stopEvent(checks, { stopHookActive: true }))
    expect(decision).toMatchObject({ action: 'allow', condition: 'unverified' })
    expect(decision.state.done).toBe(false)
    expect(decision.state.blocks).toBe(2)
    expect(decision.state.consecutiveBlocks).toBe(0)
  }
})

test('every required task done with passing checks completes', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'done', C: 'done' }, blocks: 2, consecutiveBlocks: 2 })
  const decision = decide(flow, state, stopEvent({ A: [pass('A')], B: [pass('B')] }, { stopHookActive: true }))
  expect(decision).toMatchObject({ action: 'complete', condition: 'complete' })
  expect(decision.state.done).toBe(true)
  expect(decision.state.consecutiveBlocks).toBe(0)
  expect(decision.state.blocks).toBe(2)
})

test('branch-only onFail targets do not count for completion', () => {
  const { flow, hash } = build([task('A', { onFail: 'DEBUG' }), task('DEBUG', { dependsOn: [] })])
  const state = approved(flow, hash, { status: { A: 'done', DEBUG: 'pending' } })
  expect(decide(flow, state, stopEvent({ A: [pass('A')] }))).toMatchObject({ action: 'complete', condition: 'complete' })
})

test('otherwise a stop continues, naming the active task and its acceptance', () => {
  const { flow, hash } = build([task('A', { acceptance: { checks: [check('A')], criteria: ['covers the edge case'] } })])
  const decision = decide(flow, approved(flow, hash), stopEvent())
  expect(decision).toMatchObject({ action: 'block', condition: 'continue', task: 'A' })
  expect(decision.reason).toContain('goal A')
  expect(decision.reason).toContain('covers the edge case')
  expect(decision.reason).toContain('run A')
  expect(decision.state.blocks).toBe(1)
  expect(decision.state.lastInstruction).toBe(decision.reason)
})

test('blocks accumulate across stops and stop at maxBlocks', () => {
  const { flow, hash } = build([task('A')], { maxBlocks: 3 })
  let state = approved(flow, hash)
  const seen: string[] = []
  for (let i = 0; i < 4; i++) {
    const decision = decide(flow, state, stopEvent({}, { stopHookActive: i > 0 }))
    seen.push(decision.condition)
    state = decision.state
  }
  expect(seen).toEqual(['continue', 'continue', 'continue', 'budget'])
  expect(state.blocks).toBe(3)
})

// --- task end ---

test('a task end for a task that is not the active one is allowed untouched', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash)
  for (const id of ['B', 'ghost']) {
    const decision = decide(flow, state, endEvent(id, [fail(id)]))
    expect(decision).toMatchObject({ action: 'allow', condition: 'not_active' })
    expect(decision.state).toEqual(state)
  }
})

test('ownership denials fail the task and count an attempt', () => {
  const { flow, hash } = chain()
  const decision = decide(flow, approved(flow, hash), endEvent('A', [pass('A')], 2))
  expect(decision).toMatchObject({ action: 'failTask', condition: 'ownership', task: 'A' })
  expect(decision.reason).toContain('src/A.ts')
  expect(decision.state.attempts.A).toBe(1)
  expect(decision.state.status.A).toBe('active')
})

test('failing checks retry, then ask the oracle, then ask the person', () => {
  const { flow, hash } = chain()
  const one = decide(flow, approved(flow, hash), endEvent('A', [fail('A', 'first')]))
  expect(one).toMatchObject({ action: 'failTask', condition: 'retry', task: 'A' })
  expect(one.reason).toContain('first')
  expect(one.reason).toContain('same implementer')
  expect(one.state.attempts.A).toBe(1)
  const two = decide(flow, one.state, endEvent('A', [fail('A', 'second')]))
  expect(two).toMatchObject({ action: 'failTask', condition: 'oracle' })
  expect(two.reason).toContain('oracle')
  expect(two.state.attempts.A).toBe(2)
  const three = decide(flow, two.state, endEvent('A', [fail('A', 'third')]))
  expect(three).toMatchObject({ action: 'pause', condition: 'ask_person' })
  expect(three.state.paused).toBe(true)
  expect(three.state.lastInstruction).toBe(three.reason)
})

test('a check that could not run, or no check result at all, fails the task end', () => {
  const { flow, hash } = chain()
  const unable = decide(flow, approved(flow, hash), endEvent('A', [{ argv: ['run', 'A'], passed: null, output: 'timeout' }]))
  expect(unable).toMatchObject({ action: 'failTask', condition: 'retry' })
  expect(unable.reason).toContain('timeout')
  const missing = decide(flow, approved(flow, hash), endEvent('A', []))
  expect(missing).toMatchObject({ action: 'failTask', condition: 'retry' })
  expect(missing.reason).toContain('no result reported')
})

test('maxAttempts from the flow moves the ladder', () => {
  const { flow, hash } = build([task('A')], { maxAttempts: 1 })
  expect(decide(flow, approved(flow, hash), endEvent('A', [fail('A')])).condition).toBe('oracle')
  const wide = build([task('A')], { maxAttempts: 3 })
  const state = approved(wide.flow, wide.hash, { attempts: { A: 1 } })
  expect(decide(wide.flow, state, endEvent('A', [fail('A')])).condition).toBe('retry')
})

test('a loop task uses maxIterations instead of maxAttempts', () => {
  const { flow, hash } = build([task('A', { loop: { maxIterations: 4 } })])
  const state = approved(flow, hash, { attempts: { A: 2 } })
  expect(decide(flow, state, endEvent('A', [fail('A')])).condition).toBe('retry')
  expect(decide(flow, { ...state, attempts: { A: 3 } }, endEvent('A', [fail('A')])).condition).toBe('oracle')
  expect(decide(flow, { ...state, attempts: { A: 4 } }, endEvent('A', [fail('A')])).condition).toBe('ask_person')
})

test('exhausted attempts move to the onFail task', () => {
  const { flow, hash } = build([task('A', { onFail: 'DEBUG' }), task('B'), task('DEBUG', { dependsOn: [] })])
  const state = approved(flow, hash, { attempts: { A: 1 } })
  const decision = decide(flow, state, endEvent('A', [fail('A', 'nope')]))
  expect(decision).toMatchObject({ action: 'advance', condition: 'on_fail', task: 'DEBUG' })
  expect(decision.state.status).toEqual({ A: 'failed', B: 'pending', DEBUG: 'active' })
  expect(decision.reason).toContain('nope')
  // The branch is done: the failed task comes back, with its attempts kept so one more failure asks the person.
  const back = decide(flow, decision.state, endEvent('DEBUG', [pass('DEBUG')]))
  expect(back).toMatchObject({ action: 'advance', condition: 'task_done', task: 'A' })
  expect(back.state.attempts.A).toBe(2)
  expect(decide(flow, back.state, endEvent('A', [fail('A')])).condition).toBe('ask_person')
})

test('passing checks on a risky task park it in awaitingReview, not done', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' } })
  const decision = decide(flow, state, endEvent('B', [pass('B')]))
  expect(decision).toMatchObject({ action: 'allow', condition: 'review_needed', task: 'B' })
  expect(decision.reason).toContain('oracle')
  expect(decision.state.status.B).toBe('active')
  expect(decision.state.awaitingReview).toEqual(['B'])
  expect(decision.state.blocks).toBe(0)
  // A second pass does not duplicate the entry.
  expect(decide(flow, decision.state, endEvent('B', [pass('B')])).state.awaitingReview).toEqual(['B'])
})

test('an approved review finishes the task like any passing task end', () => {
  const { flow, hash } = chain()
  const awaiting = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaitingReview: ['B'], attempts: { B: 1 } })
  const done = decide(flow, awaiting, { kind: 'review', taskId: 'B', verdict: 'approved' })
  expect(done).toMatchObject({ action: 'advance', condition: 'task_done', task: 'C' })
  expect(done.state.status).toEqual({ A: 'done', B: 'done', C: 'active' })
  expect(done.state.awaitingReview).toEqual([])
  expect(done.state.reviewed).toEqual(['B'])
  expect(done.state.attempts.B).toBeUndefined()
  expect(done.state.lastInstruction).toBe(done.reason)
})

test('an approved review of the last required task says all_done and records the side effect', () => {
  const { flow, hash } = build([task('A', { risk: true, sideEffect: true })])
  const awaiting = approved(flow, hash, { awaitingReview: ['A'] })
  const done = decide(flow, awaiting, { kind: 'review', taskId: 'A', verdict: 'approved' })
  expect(done).toMatchObject({ action: 'advance', condition: 'all_done' })
  expect(done.state.sideEffectsDone).toEqual(['A'])
  expect(done.state.done).toBe(false)
})

test('a rejected review is a failed attempt with the note as its output, down the same ladder', () => {
  const { flow, hash } = chain()
  const awaiting = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaitingReview: ['B'], reviewed: ['B'] })
  const one = decide(flow, awaiting, { kind: 'review', taskId: 'B', verdict: 'rejected', note: 'misses the null case' })
  expect(one).toMatchObject({ action: 'failTask', condition: 'retry', task: 'B' })
  expect(one.reason).toContain('misses the null case')
  expect(one.state.awaitingReview).toEqual([])
  expect(one.state.reviewed).toEqual([])
  expect(one.state.attempts.B).toBe(1)
  expect(one.state.status.B).toBe('active')
  // Back through task end and a second rejection: oracle, then the person.
  const again = decide(flow, { ...one.state, awaitingReview: ['B'] }, { kind: 'review', taskId: 'B', verdict: 'rejected' })
  expect(again.condition).toBe('oracle')
  const last = decide(flow, { ...again.state, awaitingReview: ['B'] }, { kind: 'review', taskId: 'B', verdict: 'rejected' })
  expect(last).toMatchObject({ action: 'pause', condition: 'ask_person' })
})

test('a rejected review on a task with onFail moves to the branch', () => {
  const { flow, hash } = build([task('A', { risk: true, onFail: 'D' }), task('D', { dependsOn: [] })])
  const awaiting = approved(flow, hash, { awaitingReview: ['A'], attempts: { A: 1 } })
  const decision = decide(flow, awaiting, { kind: 'review', taskId: 'A', verdict: 'rejected' })
  expect(decision).toMatchObject({ action: 'advance', condition: 'on_fail', task: 'D' })
})

test('a failed task end takes the task out of reviewed and awaitingReview', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaitingReview: ['B'], reviewed: ['B'] })
  const decision = decide(flow, state, endEvent('B', [fail('B')]))
  expect(decision.condition).toBe('retry')
  expect(decision.state.awaitingReview).toEqual([])
  expect(decision.state.reviewed).toEqual([])
})

test('a review for a task not awaiting review is ignored', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash)
  for (const taskId of ['B', 'ghost']) {
    for (const verdict of ['approved', 'rejected'] as const) {
      const decision = decide(flow, state, { kind: 'review', taskId, verdict })
      expect(decision).toMatchObject({ action: 'allow', condition: 'review_ignored' })
      expect(decision.state).toEqual(state)
    }
  }
})

test('passing checks mark the task done, reset its bookkeeping and activate the next', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { attempts: { A: 1 }, lastFailure: { key: 'A\nx', count: 2 }, blocks: 1, consecutiveBlocks: 1 })
  const decision = decide(flow, state, endEvent('A', [pass('A')]))
  expect(decision).toMatchObject({ action: 'advance', condition: 'task_done', task: 'B' })
  expect(decision.state.status).toEqual({ A: 'done', B: 'active', C: 'pending' })
  expect(decision.state.attempts.A).toBeUndefined()
  expect(decision.state.lastFailure).toBeUndefined()
  // An advance is progress: it spends no block budget.
  expect(decision.state.blocks).toBe(1)
  expect(decision.state.consecutiveBlocks).toBe(1)
  expect(decision.state.lastInstruction).toBe(decision.reason)
})

test('a criteria-only task counts as passing', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'done', C: 'active' } })
  const decision = decide(flow, state, endEvent('C', []))
  expect(decision).toMatchObject({ action: 'advance', condition: 'all_done' })
  expect(decision.state.status.C).toBe('done')
  expect(decision.state.done).toBe(false)
})

test('finishing the last required task says all_done even when a branch-only task is pending', () => {
  const { flow, hash } = build([task('A', { onFail: 'DEBUG' }), task('DEBUG', { dependsOn: [] })])
  const decision = decide(flow, approved(flow, hash), endEvent('A', [pass('A')]))
  expect(decision).toMatchObject({ action: 'advance', condition: 'all_done' })
  expect(decision.reason).toContain('verify')
  expect(decision.task).toBeUndefined()
  expect(decision.state.status).toEqual({ A: 'done', DEBUG: 'pending' })
  expect(decision.state.done).toBe(false)
})

test('a task end never completes the flow, whatever the last event was', () => {
  const { flow, hash } = build([task('A'), task('B')])
  const first = decide(flow, approved(flow, hash), endEvent('A', [pass('A')]))
  const last = decide(flow, first.state, endEvent('B', [pass('B')]))
  expect(last.action).not.toBe('complete')
  expect(last.state.done).toBe(false)
})

test('parallel tasks: an eligible task may finish ahead of its turn without changing the active one', () => {
  const { flow, hash } = build([task('cli', { dependsOn: [] }), task('docs', { dependsOn: [] }), task('final', { dependsOn: ['cli', 'docs'] })])
  const state = approved(flow, hash)
  const early = decide(flow, state, endEvent('docs', [pass('docs')]))
  expect(early).toMatchObject({ action: 'advance', condition: 'task_done', task: 'cli' })
  expect(early.state.status).toEqual({ cli: 'active', docs: 'done', final: 'pending' })
  const join = decide(flow, early.state, endEvent('cli', [pass('cli')]))
  expect(join).toMatchObject({ action: 'advance', task: 'final' })
  expect(join.state.status).toEqual({ cli: 'done', docs: 'done', final: 'active' })
  // A task that is neither active nor eligible is still not acted on.
  expect(decide(flow, state, endEvent('final', [pass('final')])).condition).toBe('not_active')
})

test('several tasks may be active at once and all are named on a continue', () => {
  const { flow, hash } = build([task('cli', { dependsOn: [] }), task('docs', { dependsOn: [] })])
  const state = approved(flow, hash, { status: { cli: 'active', docs: 'active' } })
  const stop = decide(flow, state, stopEvent())
  expect(stop.condition).toBe('continue')
  expect(stop.reason).toContain('cli')
  expect(stop.reason).toContain('docs')
  // Finishing one leaves the other active and starts nothing new.
  const one = decide(flow, state, endEvent('cli', [pass('cli')]))
  expect(one.state.status).toEqual({ cli: 'done', docs: 'active' })
})

test('a finished side-effect task is recorded and never re-activated', () => {
  const { flow, hash } = build([task('A', { sideEffect: true }), task('B')])
  const done = decide(flow, approved(flow, hash), endEvent('A', [pass('A')]))
  expect(done.state.sideEffectsDone).toEqual(['A'])
  expect(done.state.status.A).toBe('done')
  // The state file is lost and restored from the ledger: the status says pending, the ledger says done.
  const restored = approved(flow, hash, { status: { A: 'pending', B: 'pending' }, sideEffectsDone: ['A'] })
  const next = decide(flow, restored, stopEvent({}))
  expect(next.state.status).toEqual({ A: 'done', B: 'active' })
  expect(next.task).toBe('B')
  // A task end for it is not the active task's.
  expect(decide(flow, restored, endEvent('A', [pass('A')])).condition).toBe('not_active')
})

// --- human prompt and review ---

test('a human prompt refills the budget', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { blocks: 5, consecutiveBlocks: 4 })
  const decision = decide(flow, state, { kind: 'humanPrompt' })
  expect(decision).toMatchObject({ action: 'allow', condition: 'refill' })
  expect(decision.state.blocks).toBe(0)
  expect(decision.state.consecutiveBlocks).toBe(0)
})

// --- purity and judgment ---

const scenarios = (): { name: string; flow: Flow; state: FlowState; event: FlowEvent }[] => {
  const c = chain()
  const reviewed = approved(c.flow, c.hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaitingReview: ['B'] })
  const fan = build([task('A', { onFail: 'D' }), task('D', { dependsOn: [] })])
  return [
    { name: 'check_failed', flow: c.flow, state: approved(c.flow, c.hash), event: stopEvent({ A: [fail('A')] }) },
    { name: 'continue', flow: c.flow, state: approved(c.flow, c.hash), event: stopEvent() },
    { name: 'waiting', flow: c.flow, state: approved(c.flow, c.hash), event: stopEvent({}, { backgroundTasks: 1 }) },
    { name: 'budget', flow: c.flow, state: approved(c.flow, c.hash, { blocks: 6 }), event: stopEvent({ A: [pass('A')] }) },
    { name: 'review_needed', flow: c.flow, state: reviewed, event: stopEvent({ A: [pass('A')], B: [pass('B')] }) },
    { name: 'regression', flow: c.flow, state: reviewed, event: stopEvent({ A: [fail('A')] }) },
    { name: 'complete', flow: c.flow, state: approved(c.flow, c.hash, { status: { A: 'done', B: 'done', C: 'done' } }), event: stopEvent({ A: [pass('A')], B: [pass('B')] }) },
    { name: 'retry', flow: c.flow, state: approved(c.flow, c.hash), event: endEvent('A', [fail('A')]) },
    { name: 'oracle', flow: c.flow, state: approved(c.flow, c.hash, { attempts: { A: 1 } }), event: endEvent('A', [fail('A')]) },
    { name: 'ask_person', flow: c.flow, state: approved(c.flow, c.hash, { attempts: { A: 2 } }), event: endEvent('A', [fail('A')]) },
    { name: 'on_fail', flow: fan.flow, state: approved(fan.flow, fan.hash, { attempts: { A: 1 } }), event: endEvent('A', [fail('A')]) },
    { name: 'task_done', flow: c.flow, state: approved(c.flow, c.hash), event: endEvent('A', [pass('A')]) },
    { name: 'ownership', flow: c.flow, state: approved(c.flow, c.hash), event: endEvent('A', [pass('A')], 1) },
    { name: 'review_approved', flow: c.flow, state: reviewed, event: { kind: 'review', taskId: 'B', verdict: 'approved' } },
    { name: 'review_rejected', flow: c.flow, state: reviewed, event: { kind: 'review', taskId: 'B', verdict: 'rejected', note: 'no' } },
    { name: 'review_pending', flow: c.flow, state: reviewed, event: endEvent('B', [pass('B')]) },
    { name: 'all_done', flow: c.flow, state: approved(c.flow, c.hash, { status: { A: 'done', B: 'done', C: 'active' } }), event: endEvent('C', []) },
    { name: 'unverified', flow: c.flow, state: approved(c.flow, c.hash, { status: { A: 'done', B: 'done', C: 'done' } }), event: stopEvent() },
    { name: 'unapproved', flow: c.flow, state: newState(c.flow, c.hash), event: stopEvent() },
    { name: 'refill', flow: c.flow, state: approved(c.flow, c.hash, { blocks: 4 }), event: { kind: 'humanPrompt' } },
  ]
}

test('decide never mutates its input, frozen to the last nested array', () => {
  for (const { name, flow, state, event } of scenarios()) {
    const before = clone({ flow, state, event })
    const result = decide(deepFreeze(clone(flow)), deepFreeze(clone(state)), deepFreeze(clone(event)))
    expect({ name, ...clone({ flow, state, event }) }).toEqual({ name, ...before })
    expect(result.state).not.toBe(state)
  }
})

test('a judgment of any value never changes the action, the condition or the state', () => {
  const judgments: (Judgment | undefined)[] = [
    undefined,
    { source: 'none', reason: 'no key' },
    { source: 'jev', scores: {} },
    { source: 'jev', scores: { claimsDone: 0.99, complete: 0.99, stuck: 0 } },
    { source: 'jev', scores: { claimsDone: 0, complete: 0, stuck: 1 } },
    { source: 'jev', scores: { claimsDone: 0.5, complete: 0.5, stuck: 0.5 } },
  ]
  for (const { name, flow, state, event } of scenarios()) {
    const baseline = decide(flow, state, event)
    for (const judgment of judgments) {
      expect({ name, ...decide(flow, state, event, judgment) }).toEqual({ name, ...baseline })
    }
  }
})

// --- modes ---

test('enforce returns the decision unchanged', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash)
  const decision = decide(flow, state, stopEvent())
  expect(applyMode(decision, 'enforce', state)).toBe(decision)
})

test('shadow never blocks and never charges the budget', () => {
  for (const { name, flow, state, event } of scenarios()) {
    const decision = decide(flow, state, event)
    const shadowed = applyMode(decision, 'shadow', state)
    if (['block', 'advance', 'failTask', 'pause'].includes(decision.action)) {
      expect({ name, action: shadowed.action }).toEqual({ name, action: 'allow' })
      expect(shadowed.wouldBe).toMatchObject({ action: decision.action, condition: decision.condition, reason: decision.reason })
      expect(shadowed.condition).toBe(decision.condition)
      expect(shadowed.reason).toBe('')
      expect(shadowed.state.blocks).toBe(state.blocks)
      expect(shadowed.state.consecutiveBlocks).toBe(state.consecutiveBlocks)
      expect(shadowed.state.paused).toBe(state.paused)
      expect(shadowed.state.lastInstruction).toBe(state.lastInstruction)
      // Attempts and the failure streak always follow the decision.
      expect(shadowed.state.attempts).toEqual(decision.state.attempts)
      expect(shadowed.state.lastFailure).toEqual(decision.state.lastFailure)
    } else {
      expect(shadowed).toMatchObject({ action: decision.action, condition: decision.condition, state: decision.state })
    }
  }
})

test('no shadow decision carries a non-empty reason; the original stays in wouldBe', () => {
  for (const { name, flow, state, event } of scenarios()) {
    const decision = decide(flow, state, event)
    const shadowed = applyMode(decision, 'shadow', state)
    expect({ name, reason: shadowed.reason }).toEqual({ name, reason: '' })
    expect({ name, wouldBe: shadowed.wouldBe }).toMatchObject({ wouldBe: { action: decision.action, condition: decision.condition, reason: decision.reason } })
  }
})

test('shadow keeps real progress but not the transitions that only send work back', () => {
  for (const { name, flow, state, event } of scenarios()) {
    const decision = decide(flow, state, event)
    const shadowed = applyMode(decision, 'shadow', state)
    const progress = decision.action === 'advance' && decision.condition !== 'on_fail'
    if (['block', 'advance', 'failTask', 'pause'].includes(decision.action)) {
      const kept = progress ? decision.state : state
      expect({ name, status: shadowed.state.status }).toEqual({ name, status: kept.status })
      expect({ name, reviewed: shadowed.state.reviewed }).toEqual({ name, reviewed: kept.reviewed })
      expect({ name, awaiting: shadowed.state.awaitingReview }).toEqual({ name, awaiting: kept.awaitingReview })
    }
  }
  const { flow, hash } = chain()
  const done = applyMode(decide(flow, approved(flow, hash), endEvent('A', [pass('A')])), 'shadow', approved(flow, hash))
  expect(done.wouldBe?.condition).toBe('task_done')
  expect(done.state.status.A).toBe('done')
  const regressed = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' } })
  const back = applyMode(decide(flow, regressed, stopEvent({ A: [fail('A')] })), 'shadow', regressed)
  expect(back.wouldBe?.condition).toBe('regression')
  expect(back.state.status).toEqual(regressed.status)
  const failed = applyMode(decide(flow, approved(flow, hash), endEvent('A', [fail('A')])), 'shadow', approved(flow, hash))
  expect(failed.state.attempts.A).toBe(1)
})

test('enterEnforce clears attempts, the failure streak and the budget only', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, attempts: { B: 2 }, lastFailure: { key: 'k', count: 2 }, blocks: 3, consecutiveBlocks: 2, reviewed: ['A'], lastInstruction: 'x' })
  const clean = enterEnforce(state)
  expect(clean).toMatchObject({ attempts: {}, blocks: 0, consecutiveBlocks: 0, status: state.status, reviewed: ['A'], lastInstruction: 'x', approvedHash: hash })
  expect(clean.lastFailure).toBeUndefined()
  expect(state.attempts).toEqual({ B: 2 })
})

test('shadow still lets the looping streak build so the would-be pause shows up', () => {
  const { flow, hash } = chain()
  let state = approved(flow, hash)
  const seen: string[] = []
  for (let i = 0; i < 3; i++) {
    const shadowed = applyMode(decide(flow, state, stopEvent({ A: [fail('A', 'same')] }, { stopHookActive: true })), 'shadow', state)
    seen.push(shadowed.wouldBe!.condition)
    expect(shadowed.action).toBe('allow')
    state = shadowed.state
  }
  expect(seen).toEqual(['check_failed', 'check_failed', 'looping'])
  expect(state.blocks).toBe(0)
  expect(state.paused).toBe(false)
})

test('off allows and leaves the previous state untouched', () => {
  const { flow, hash } = chain()
  const previous = approved(flow, hash, { blocks: 2 })
  const decision = decide(flow, previous, stopEvent())
  const off = applyMode(decision, 'off', previous)
  expect(off.action).toBe('allow')
  expect(off.state).toBe(previous)
  expect(off.wouldBe).toMatchObject({ action: 'block', condition: 'continue' })
})

// --- budget with regressions, settling reviews, rebase ---

test('the budget path does not complete while a done task has regressed', () => {
  const { flow, hash } = build([task('A'), task('B')])
  const state = approved(flow, hash, { status: { A: 'done', B: 'active' }, blocks: 6 })
  const decision = decide(flow, state, stopEvent({ A: [fail('A', 'A broke')], B: [pass('B')] }))
  expect(decision).toMatchObject({ action: 'allow', condition: 'budget' })
  expect(decision.state.done).toBe(false)
  expect(decision.reason).toContain('Regressed')
  expect(decision.reason).toContain('A')
  expect(decision.reason).not.toContain('every task')
  expect(decision.reason).not.toContain('flow is complete')
})

test('the budget path completes only when nothing is open, regressed or unverified', () => {
  const { flow, hash } = build([task('A'), task('B')])
  const state = approved(flow, hash, { status: { A: 'done', B: 'active' }, blocks: 6 })
  expect(decide(flow, state, stopEvent({ A: [pass('A')], B: [pass('B')] })).condition).toBe('complete')
  expect(decide(flow, state, stopEvent({ B: [pass('B')] })).condition).toBe('budget')
})

test('settling by checks skips a risk task without a review receipt', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, blocks: 6 })
  const unreviewed = decide(flow, state, stopEvent({ A: [pass('A')], B: [pass('B')] }))
  expect(unreviewed.condition).toBe('budget')
  expect(unreviewed.state.status.B).toBe('active')
  expect(unreviewed.state.status.C).toBe('pending')
  const reviewed = decide(flow, { ...state, reviewed: ['B'] }, stopEvent({ A: [pass('A')], B: [pass('B')] }))
  expect(reviewed.state.status.B).toBe('done')
})

test('rebase keeps progress for surviving tasks, drops removed ones, adds new ones and clears the approval', () => {
  const old = build([task('A'), task('B'), task('C')])
  const state = approved(old.flow, old.hash, {
    status: { A: 'done', B: 'active', C: 'pending' }, attempts: { A: 1, B: 1, C: 2 }, reviewed: ['A', 'C'], awaitingReview: ['B', 'C'], sideEffectsDone: ['C'], blocks: 2,
  })
  const next = build([task('A'), task('B'), task('N', { dependsOn: [] })])
  const rebased = rebase(next.flow, state)
  expect(rebased.hash).toBe(flowHash(next.flow))
  expect(rebased.hash).toBe(next.hash)
  expect(rebased.approvedHash).toBeUndefined()
  expect(rebased.status).toEqual({ A: 'done', B: 'active', N: 'pending' })
  expect(rebased.attempts).toEqual({ A: 1, B: 1 })
  expect(rebased.reviewed).toEqual(['A'])
  expect(rebased.awaitingReview).toEqual(['B'])
  expect(rebased.sideEffectsDone).toEqual(['C'])
  expect(rebased.blocks).toBe(2)
  expect(state.status).toEqual({ A: 'done', B: 'active', C: 'pending' })
})

test('rebase re-picks an active task when none is left, and stays unapproved until approved again', () => {
  const old = build([task('A'), task('B')])
  const state = approved(old.flow, old.hash, { status: { A: 'done', B: 'active' } })
  const next = build([task('A'), task('N')])
  const rebased = rebase(next.flow, state)
  expect(rebased.status).toEqual({ A: 'done', N: 'active' })
  expect(decide(next.flow, rebased, stopEvent()).condition).toBe('unapproved')
  expect(decide(next.flow, { ...rebased, approvedHash: next.hash }, stopEvent()).condition).toBe('continue')
})

// --- mode, review guards, rebase details ---

test('withMode resets the budget once, on the switch into enforce', () => {
  const { flow, hash } = chain()
  const shadow = withMode(approved(flow, hash, { blocks: 3, consecutiveBlocks: 2, attempts: { A: 1 }, lastFailure: { key: 'k', count: 1 } }), 'shadow')
  expect(shadow).toMatchObject({ mode: 'shadow', blocks: 3, attempts: { A: 1 } })
  const entered = withMode(shadow, 'enforce')
  expect(entered).toMatchObject({ mode: 'enforce', blocks: 0, consecutiveBlocks: 0, attempts: {} })
  expect(entered.lastFailure).toBeUndefined()
  const spent = { ...entered, blocks: 2, attempts: { A: 1 } }
  expect(withMode(spent, 'enforce')).toMatchObject({ mode: 'enforce', blocks: 2, attempts: { A: 1 } })
  // A state saved before the mode existed counts as a switch.
  expect(withMode(approved(flow, hash, { blocks: 2 }), 'enforce').blocks).toBe(0)
  expect(withMode(entered, 'off').mode).toBe('off')
  expect(shadow.blocks).toBe(3)
})

test('a review on an unapproved, rebased, paused, stopped or done flow does not advance', () => {
  const { flow, hash } = chain()
  const base = { status: { A: 'done', B: 'active', C: 'pending' } as FlowState['status'], awaitingReview: ['B'] }
  const rebased = rebase(flow, approved(flow, hash, base))
  const cases: [string, FlowState][] = [
    ['unapproved', rebased],
    ['paused', approved(flow, hash, { ...base, paused: true })],
    ['stopped', approved(flow, hash, { ...base, stopped: true })],
    ['already_done', approved(flow, hash, { ...base, done: true })],
  ]
  for (const [condition, state] of cases) {
    for (const verdict of ['approved', 'rejected'] as const) {
      const decision = decide(flow, state, { kind: 'review', taskId: 'B', verdict })
      expect(decision).toMatchObject({ action: 'allow', condition })
      expect(decision.state).toEqual(state)
    }
  }
})

test('rebase reopens a completed flow, so a new task activates and the flow is no longer already_done', () => {
  const old = build([task('A')])
  const finished = approved(old.flow, old.hash, { status: { A: 'done' }, done: true })
  const next = build([task('A'), task('N')])
  const rebased = rebase(next.flow, finished)
  expect(rebased.done).toBe(false)
  expect(rebased.status).toEqual({ A: 'done', N: 'active' })
  const decision = decide(next.flow, { ...rebased, approvedHash: next.hash }, stopEvent({ A: [pass('A')] }))
  expect(decision.condition).toBe('continue')
  expect(decision.task).toBe('N')
})

test('rebase sends back a done task that is now risky and has no receipt, unless its side effect ran', () => {
  const old = build([task('A'), task('B'), task('S', { dependsOn: [] })])
  const state = approved(old.flow, old.hash, { status: { A: 'done', B: 'done', S: 'done' }, reviewed: ['B'], sideEffectsDone: ['S'], done: true })
  const next = build([task('A', { risk: true }), task('B', { risk: true }), task('S', { risk: true, dependsOn: [] })])
  const rebased = rebase(next.flow, state)
  expect(rebased.status).toEqual({ A: 'active', B: 'done', S: 'done' })
  expect(rebased.reviewed).toEqual(['B'])
})
