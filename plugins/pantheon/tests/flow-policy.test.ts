import { expect, test } from 'claude-code/testing'
import { flowHash, validateFlow } from '../hooks/flow/plan'
import type { Flow } from '../hooks/flow/plan'
import { applyMode, decide as decideWith, enterEnforce, newState, OUTPUT_TAIL, rebase, requiredReceipts, withMode } from '../hooks/flow/policy'
import type { StopOptions } from '../hooks/flow/policy'
import type { CheckResult, DecideOptions, FlowEvent, FlowState, Judgment } from '../hooks/flow/types'

// `decide` makes the caller say which roles are enabled; the tests say "all of them" unless a test cares.
const ALL = { qa: true, architect: true }
const decide = (flow: Flow, state: FlowState, event: FlowEvent, judgment?: Judgment, opts: StopOptions = { available: ALL }) =>
  decideWith(flow, state, event, judgment, opts)

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
  expect(state).toMatchObject({ planId: 'p', hash, blocks: 0, consecutiveBlocks: 0, paused: false, stopped: false, done: false, awaiting: [], receipts: {}, sideEffectsDone: [] })
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

test('an unapproved flow, or a state that is not for the flow in force, is allowed with the state exactly as it was', () => {
  const { flow, hash } = chain()
  const cases: FlowState[] = [
    { ...newState(flow, hash), blocks: 2, consecutiveBlocks: 3 },
    { ...newState(flow, hash), approvedHash: 'other', blocks: 2, consecutiveBlocks: 3 },
    // Approved, but the state's progress is for another flow than the one in force.
    { ...newState(flow, 'old'), approvedHash: 'old', blocks: 2, consecutiveBlocks: 3 },
    { ...newState(flow, 'old'), approvedHash: hash, blocks: 2, consecutiveBlocks: 3 },
    // An adoption that names another flow than the one in force (the approval alone does not stand for it).
    { ...newState(flow, hash), approvedHash: hash, adoptedHash: 'elsewhere', blocks: 2, consecutiveBlocks: 3 },
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
    // A paused or stopped flow still counts the delivery; a finished one is untouched.
    expect(decision.state).toEqual(condition === 'already_done' ? state : { ...state, ends: { A: 1 } })
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
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, receipts: { A: { architect: true } }, awaiting: [{ task: 'B', by: 'architect' }], attempts: { A: 2 } })
  const decision = decide(flow, state, stopEvent({ A: [fail('A', 'A broke')], B: [pass('B')] }))
  expect(decision).toMatchObject({ action: 'block', condition: 'regression', task: 'A' })
  expect(decision.reason).toContain('A broke')
  expect(decision.reason).toContain('[A]')
  expect(decision.state.status).toEqual({ A: 'active', B: 'pending', C: 'pending' })
  expect(decision.state.attempts.A).toBeUndefined()
  expect(decision.state.receipts).toEqual({})
  expect(decision.state.awaiting).toEqual([])
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

test('a delivered task whose check could not run ends the Stop as unverified: no attempt is spent, nothing is blocked', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { ends: { A: 1 } })
  const decision = decide(flow, state, stopEvent({ A: [{ argv: ['run', 'A'], passed: null, output: 'working directory web does not exist', couldNotRun: true }] }))
  expect(decision).toMatchObject({ action: 'allow', condition: 'unverified' })
  expect(decision.reason).toContain('run A')
  expect(decision.reason).toContain('could not run')
  expect(decision.reason).toContain('working directory web does not exist')
  expect(decision.reason).toContain('Create the directory the check needs')
  expect(decision.state.blocks).toBe(0)
  expect(decision.state.attempts).toEqual({})
  expect(decision.state.status).toEqual({ A: 'active', B: 'pending', C: 'pending' })
  expect(decision.state.done).toBe(false)
  expect(decision.state.lastFailure).toBeUndefined()
  // Held the same way on a second Stop: still no attempt, still not a loop.
  const again = decide(flow, decision.state, stopEvent({ A: [{ argv: ['run', 'A'], passed: null, output: 'x', couldNotRun: true }] }, { stopHookActive: true }))
  expect(again).toMatchObject({ action: 'allow', condition: 'unverified' })
  expect(again.state.blocks).toBe(0)
})

test('an undelivered task whose check could not run is not unverified: the Stop continues the work and blocks', () => {
  const { flow, hash } = chain()
  const decision = decide(flow, approved(flow, hash), stopEvent({ A: [{ argv: ['run', 'A'], passed: null, output: 'working directory web does not exist', couldNotRun: true }] }))
  expect(decision).toMatchObject({ action: 'block', condition: 'continue' })
  expect(decision.reason).toContain('Task A is not finished')
  expect(decision.state.blocks).toBe(1)
  expect(decision.state.attempts).toEqual({})
})

test('a delivered task whose check could not run does not end the Stop while a receipt is awaited: the architect block remains', () => {
  const { flow, hash } = build([task('A'), task('B', { risk: true })])
  const state = approved(flow, hash, {
    status: { A: 'active', B: 'active' }, ends: { A: 1, B: 1 }, awaiting: [{ task: 'B', by: 'architect' }],
  })
  const decision = decide(flow, state, stopEvent({
    A: [{ argv: ['run', 'A'], passed: null, output: 'gone', couldNotRun: true }],
    B: [pass('B')],
  }))
  expect(decision).toMatchObject({ action: 'block', condition: 'review_needed', task: 'B' })
  expect(decision.reason).toContain('architect')
  expect(decision.reason).toContain('B')
})

test('a delivered task whose check could not run does not end the Stop while a required task is pending and eligible: the block remains', () => {
  const { flow, hash } = build([task('A', { dependsOn: [] }), task('B', { dependsOn: [] })])
  const state = approved(flow, hash, { ends: { A: 1 } })
  const decision = decide(flow, state, stopEvent({ A: [{ argv: ['run', 'A'], passed: null, output: 'gone', couldNotRun: true }] }))
  expect(decision).toMatchObject({ action: 'block', condition: 'continue' })
  expect(decision.state.blocks).toBe(1)
  expect(decision.state.attempts).toEqual({})
})

test('a required task waiting on the unverified one is not eligible, so the Stop ends as unverified', () => {
  const { flow, hash } = build([task('A', { dependsOn: [] }), task('B', { dependsOn: ['A'] })])
  const decision = decide(flow, approved(flow, hash, { ends: { A: 1 } }), stopEvent({ A: [{ argv: ['run', 'A'], passed: null, output: 'gone', couldNotRun: true }] }))
  expect(decision).toMatchObject({ action: 'allow', condition: 'unverified' })
  expect(decision.state.attempts).toEqual({})
})

test('a side effect whose only check could not run pauses for the person at the task end, never delegated again', () => {
  const { flow, hash } = build([task('A', { sideEffect: true })])
  const decision = decide(flow, approved(flow, hash), endEvent('A', [{ argv: ['run', 'A'], passed: null, output: 'working directory x does not exist', couldNotRun: true }]))
  expect(decision).toMatchObject({ action: 'pause', condition: 'ask_person', task: 'A' })
  expect(decision.state.paused).toBe(true)
  expect(decision.state.sideEffectsDone).toEqual(['A'])
  expect(decision.state.attempts).toEqual({})
  expect(decision.reason).toContain('by hand')
  // Resume marks the task done, so the text must say what that means before the person resumes or stops.
  expect(decision.reason).toContain('/pantheon flow resume treats the task as done and starts what depends on it')
  expect(decision.reason).toContain('/pantheon flow stop')
  expect(decision.reason).not.toContain('delegate')
})

test('a check that timed out or whose runner exited counts as failing and says so', () => {
  const { flow, hash } = chain()
  for (const output of ['timed out after 120s: run A', 'exit code 127']) {
    const decision = decide(flow, approved(flow, hash), stopEvent({ A: [{ argv: ['run', 'A'], passed: null, output }] }))
    expect(decision).toMatchObject({ action: 'block', condition: 'check_failed' })
    expect(decision.reason).toContain('could not run')
    expect(decision.reason).toContain(output)
    expect(decision.state.blocks).toBe(1)
  }
})

test('at Stop a real failure still blocks when another check of the task could not run', () => {
  const { flow, hash } = build([task('A', { acceptance: { checks: [check('a1'), check('a2')] } }), task('B', { dependsOn: ['A'] })])
  const decision = decide(flow, approved(flow, hash), stopEvent({ A: [{ argv: ['run', 'a1'], passed: null, output: 'gone', couldNotRun: true }, fail('a2', 'FAILED')] }))
  expect(decision).toMatchObject({ action: 'block', condition: 'check_failed', task: 'A' })
  expect(decision.state.blocks).toBe(1)
  expect(decision.state.attempts).toEqual({})
  expect(decision.reason).toContain('FAILED')
})

test('at Stop a real failure of one task blocks even when another active task could not run', () => {
  const { flow, hash } = build([task('A'), task('B')])
  const state = approved(flow, hash, { status: { A: 'active', B: 'active' } })
  const decision = decide(flow, state, stopEvent({
    A: [{ argv: ['run', 'A'], passed: null, output: 'gone', couldNotRun: true }],
    B: [fail('B', 'FAILED')],
  }))
  expect(decision).toMatchObject({ action: 'block', condition: 'check_failed', task: 'B' })
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

test('a risky task awaiting review blocks the stop asking for the architect', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaiting: [{ task: 'B', by: 'architect' }] })
  const decision = decide(flow, state, stopEvent({ A: [pass('A')], B: [pass('B')] }))
  expect(decision).toMatchObject({ action: 'block', condition: 'review_needed', task: 'B' })
  expect(decision.reason).toContain('architect')
  expect(decision.state.blocks).toBe(1)
})

test('an active risky task that has not passed its checks yet just continues', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' } })
  expect(decide(flow, state, stopEvent({ A: [pass('A')] })).condition).toBe('continue')
  expect(decide(flow, state, stopEvent({ A: [pass('A')], B: [pass('B')] })).condition).toBe('continue')
})

test('checks that fail while a receipt is pending or earned drop the task from awaiting and receipts', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaiting: [{ task: 'B', by: 'architect' }], receipts: { A: { architect: true }, B: { qa: true } } })
  const decision = decide(flow, state, stopEvent({ A: [pass('A')], B: [fail('B')] }))
  expect(decision.condition).toBe('check_failed')
  expect(decision.state.awaiting).toEqual([])
  expect(decision.state.receipts).toEqual({ A: { architect: true } })
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

test('failing checks retry, then ask the architect, then ask the person', () => {
  const { flow, hash } = chain()
  const one = decide(flow, approved(flow, hash), endEvent('A', [fail('A', 'first')]))
  expect(one).toMatchObject({ action: 'failTask', condition: 'retry', task: 'A' })
  expect(one.reason).toContain('first')
  expect(one.reason).toContain('same implementer')
  expect(one.state.attempts.A).toBe(1)
  const two = decide(flow, one.state, endEvent('A', [fail('A', 'second')]))
  expect(two).toMatchObject({ action: 'failTask', condition: 'architect' })
  expect(two.reason).toContain('architect')
  expect(two.state.attempts.A).toBe(2)
  const three = decide(flow, two.state, endEvent('A', [fail('A', 'third')]))
  expect(three).toMatchObject({ action: 'pause', condition: 'ask_person' })
  expect(three.state.paused).toBe(true)
  expect(three.state.lastInstruction).toBe(three.reason)
})

test('a check that timed out, or no check result at all, fails the task end', () => {
  const { flow, hash } = chain()
  const unable = decide(flow, approved(flow, hash), endEvent('A', [{ argv: ['run', 'A'], passed: null, output: 'timeout' }]))
  expect(unable).toMatchObject({ action: 'failTask', condition: 'retry' })
  expect(unable.reason).toContain('timeout')
  expect(unable.state.attempts).toEqual({ A: 1 })
  const missing = decide(flow, approved(flow, hash), endEvent('A', []))
  expect(missing).toMatchObject({ action: 'failTask', condition: 'retry' })
  expect(missing.reason).toContain('no result reported')
})

test('a delivery whose checks could not run is unverified at the task end: no attempt, the task stays active', () => {
  const { flow, hash } = chain()
  const decision = decide(flow, approved(flow, hash), endEvent('A', [{ argv: ['run', 'A'], passed: null, output: 'working directory web does not exist, so run A could not run', couldNotRun: true }]))
  expect(decision).toMatchObject({ action: 'allow', condition: 'unverified', task: 'A' })
  expect(decision.reason).toContain('run A')
  expect(decision.reason).toContain('could not run')
  expect(decision.reason).toContain('working directory web does not exist')
  expect(decision.state.attempts).toEqual({})
  expect(decision.state.status).toEqual({ A: 'active', B: 'pending', C: 'pending' })
  expect(decision.state.done).toBe(false)
  // The delivery is still counted, so a later review of the older delivery is ignored.
  expect(decision.state.ends).toEqual({ A: 1 })
  // Nothing can be earned on that delivery: the receipts it had are cleared.
  const earned = approved(flow, hash, { receipts: { A: { architect: true } } })
  expect(decide(flow, earned, endEvent('A', [{ argv: ['run', 'A'], passed: null, output: 'x', couldNotRun: true }])).state.receipts).toEqual({})
  // Repeated deliveries never spend the ladder.
  let state = approved(flow, hash)
  for (let i = 0; i < 5; i++) state = decide(flow, state, endEvent('A', [{ argv: ['run', 'A'], passed: null, output: 'x', couldNotRun: true }])).state
  expect(state.attempts).toEqual({})
  expect(state.paused).toBe(false)
})

test('a delivery with a real failure and a check that could not run still fails and spends an attempt', () => {
  const { flow, hash } = build([task('A', { acceptance: { checks: [check('a1'), check('a2')] } })])
  const decision = decide(flow, approved(flow, hash), endEvent('A', [{ argv: ['run', 'a1'], passed: null, output: 'gone', couldNotRun: true }, fail('a2', 'FAILED')]))
  expect(decision).toMatchObject({ action: 'failTask', condition: 'retry', task: 'A' })
  expect(decision.state.attempts).toEqual({ A: 1 })
  expect(decision.reason).toContain('FAILED')
})

test('a delivery whose only non-passing check is a timeout still fails and spends an attempt', () => {
  const { flow, hash } = build([task('A', { acceptance: { checks: [check('a1'), check('a2')] } })])
  const decision = decide(flow, approved(flow, hash), endEvent('A', [{ argv: ['run', 'a1'], passed: null, output: 'timed out after 5s: run a1' }, pass('a2')]))
  expect(decision).toMatchObject({ action: 'failTask', condition: 'retry' })
  expect(decision.state.attempts).toEqual({ A: 1 })
})

test('an unverified delivery with an ownership denial still fails as before', () => {
  const { flow, hash } = chain()
  const decision = decide(flow, approved(flow, hash), endEvent('A', [{ argv: ['run', 'A'], passed: null, output: 'x', couldNotRun: true }], 1))
  expect(decision).toMatchObject({ action: 'failTask', condition: 'ownership', task: 'A' })
  expect(decision.state.attempts).toEqual({ A: 1 })
})

test('maxAttempts from the flow moves the ladder', () => {
  const { flow, hash } = build([task('A')], { maxAttempts: 1 })
  expect(decide(flow, approved(flow, hash), endEvent('A', [fail('A')])).condition).toBe('architect')
  const wide = build([task('A')], { maxAttempts: 3 })
  const state = approved(wide.flow, wide.hash, { attempts: { A: 1 } })
  expect(decide(wide.flow, state, endEvent('A', [fail('A')])).condition).toBe('retry')
})

test('a loop task uses maxIterations instead of maxAttempts', () => {
  const { flow, hash } = build([task('A', { loop: { maxIterations: 4 } })])
  const state = approved(flow, hash, { attempts: { A: 2 } })
  expect(decide(flow, state, endEvent('A', [fail('A')])).condition).toBe('retry')
  expect(decide(flow, { ...state, attempts: { A: 3 } }, endEvent('A', [fail('A')])).condition).toBe('architect')
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

test('passing checks on a risky task park it in awaiting, not done', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' } })
  const decision = decide(flow, state, endEvent('B', [pass('B')]))
  expect(decision).toMatchObject({ action: 'allow', condition: 'review_needed', task: 'B' })
  expect(decision.reason).toContain('architect')
  expect(decision.state.status.B).toBe('active')
  expect(decision.state.awaiting).toEqual([{ task: 'B', by: 'architect' }])
  expect(decision.state.blocks).toBe(0)
  // A second pass does not duplicate the entry.
  expect(decide(flow, decision.state, endEvent('B', [pass('B')])).state.awaiting).toEqual([{ task: 'B', by: 'architect' }])
})

test('an approved review finishes the task like any passing task end', () => {
  const { flow, hash } = chain()
  const awaiting = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaiting: [{ task: 'B', by: 'architect' }], attempts: { B: 1 } })
  const done = decide(flow, awaiting, { kind: 'review', end: 0, taskId: 'B', by: 'architect', verdict: 'pass' })
  expect(done).toMatchObject({ action: 'advance', condition: 'task_done', task: 'C' })
  expect(done.state.status).toEqual({ A: 'done', B: 'done', C: 'active' })
  expect(done.state.awaiting).toEqual([])
  expect(done.state.receipts.B).toEqual({ architect: true })
  expect(done.state.attempts.B).toBeUndefined()
  expect(done.state.lastInstruction).toBe(done.reason)
})

test('finishing the last required task, a side effect is recorded and says all_done', () => {
  const { flow, hash } = build([task('A', { sideEffect: true })])
  const done = decide(flow, approved(flow, hash), endEvent('A', [pass('A')]))
  expect(done).toMatchObject({ action: 'advance', condition: 'all_done' })
  expect(done.state.sideEffectsDone).toEqual(['A'])
  expect(done.state.done).toBe(false)
})

test('a rejected review is a failed attempt with the note as its output, down the same ladder', () => {
  const { flow, hash } = chain()
  const awaiting = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaiting: [{ task: 'B', by: 'architect' }], receipts: { B: { qa: true } } })
  const one = decide(flow, awaiting, { kind: 'review', end: 0, taskId: 'B', by: 'architect', verdict: 'fail', note: 'misses the null case' })
  expect(one).toMatchObject({ action: 'failTask', condition: 'retry', task: 'B' })
  expect(one.reason).toContain('misses the null case')
  expect(one.state.awaiting).toEqual([])
  expect(one.state.receipts.B).toBeUndefined()
  expect(one.state.attempts.B).toBe(1)
  expect(one.state.status.B).toBe('active')
  // Back through task end and a second rejection: architect, then the person.
  const waiting = [{ task: 'B', by: 'architect' as const }]
  const again = decide(flow, { ...one.state, awaiting: waiting }, { kind: 'review', end: 0, taskId: 'B', by: 'architect', verdict: 'fail' })
  expect(again.condition).toBe('architect')
  const last = decide(flow, { ...again.state, awaiting: waiting }, { kind: 'review', end: 0, taskId: 'B', by: 'architect', verdict: 'fail' })
  expect(last).toMatchObject({ action: 'pause', condition: 'ask_person' })
})

test('a rejected review on a task with onFail moves to the branch', () => {
  const { flow, hash } = build([task('A', { risk: true, onFail: 'D' }), task('D', { dependsOn: [] })])
  const awaiting = approved(flow, hash, { awaiting: [{ task: 'A', by: 'architect' }], attempts: { A: 1 } })
  const decision = decide(flow, awaiting, { kind: 'review', end: 0, taskId: 'A', by: 'architect', verdict: 'fail' })
  expect(decision).toMatchObject({ action: 'advance', condition: 'on_fail', task: 'D' })
})

test('a failed task end takes the task out of awaiting and receipts', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaiting: [{ task: 'B', by: 'architect' }], receipts: { A: { architect: true }, B: { architect: true } } })
  const decision = decide(flow, state, endEvent('B', [fail('B')]))
  expect(decision.condition).toBe('retry')
  expect(decision.state.awaiting).toEqual([])
  expect(decision.state.receipts).toEqual({ A: { architect: true } })
})

test('a review for a task not awaiting that reviewer is ignored', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash)
  for (const taskId of ['B', 'ghost']) {
    for (const by of ['architect', 'qa'] as const) {
      for (const verdict of ['pass', 'fail'] as const) {
        const decision = decide(flow, state, { kind: 'review', taskId, by, verdict })
        expect(decision).toMatchObject({ action: 'allow', condition: 'review_ignored' })
        expect(decision.state).toEqual(state)
      }
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

test('a criteria-only task has no check to fail but waits for QA before it counts as done', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'done', C: 'active' } })
  const decision = decide(flow, state, endEvent('C', []))
  expect(decision).toMatchObject({ action: 'allow', condition: 'qa_needed', task: 'C' })
  expect(decision.state.status.C).toBe('active')
  expect(decision.state.awaiting).toEqual([{ task: 'C', by: 'qa' }])
  const passed = decide(flow, decision.state, review('C', 'qa', 'pass', undefined, 1))
  expect(passed).toMatchObject({ action: 'advance', condition: 'all_done' })
  expect(passed.state.status.C).toBe('done')
  expect(passed.state.done).toBe(false)
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
  const reviewed = approved(c.flow, c.hash, { status: { A: 'done', B: 'active', C: 'pending' }, awaiting: [{ task: 'B', by: 'architect' }] })
  const qaWait = approved(c.flow, c.hash, { status: { A: 'done', B: 'done', C: 'active' }, awaiting: [{ task: 'C', by: 'qa' }], receipts: { B: { architect: true } } })
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
    { name: 'architect', flow: c.flow, state: approved(c.flow, c.hash, { attempts: { A: 1 } }), event: endEvent('A', [fail('A')]) },
    { name: 'ask_person', flow: c.flow, state: approved(c.flow, c.hash, { attempts: { A: 2 } }), event: endEvent('A', [fail('A')]) },
    { name: 'on_fail', flow: fan.flow, state: approved(fan.flow, fan.hash, { attempts: { A: 1 } }), event: endEvent('A', [fail('A')]) },
    { name: 'task_done', flow: c.flow, state: approved(c.flow, c.hash), event: endEvent('A', [pass('A')]) },
    { name: 'ownership', flow: c.flow, state: approved(c.flow, c.hash), event: endEvent('A', [pass('A')], 1) },
    { name: 'review_approved', flow: c.flow, state: reviewed, event: { kind: 'review', end: 0, taskId: 'B', by: 'architect', verdict: 'pass' } },
    { name: 'review_rejected', flow: c.flow, state: reviewed, event: { kind: 'review', end: 0, taskId: 'B', by: 'architect', verdict: 'fail', note: 'no' } },
    { name: 'qa_passed', flow: c.flow, state: qaWait, event: { kind: 'review', end: 0, taskId: 'C', by: 'qa', verdict: 'pass' } },
    { name: 'qa_failed', flow: c.flow, state: qaWait, event: { kind: 'review', end: 0, taskId: 'C', by: 'qa', verdict: 'fail', note: 'no' } },
    { name: 'qa_pending', flow: c.flow, state: approved(c.flow, c.hash, { status: { A: 'done', B: 'done', C: 'active' } }), event: endEvent('C', []) },
    { name: 'qa_stop', flow: c.flow, state: qaWait, event: stopEvent({ A: [pass('A')], B: [pass('B')] }) },
    { name: 'review_pending', flow: c.flow, state: reviewed, event: endEvent('B', [pass('B')]) },
    { name: 'all_done', flow: c.flow, state: qaWait, event: { kind: 'review', end: 0, taskId: 'C', by: 'qa', verdict: 'pass' } },
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
      expect({ name, receipts: shadowed.state.receipts }).toEqual({ name, receipts: kept.receipts })
      expect({ name, awaiting: shadowed.state.awaiting }).toEqual({ name, awaiting: kept.awaiting })
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
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, attempts: { B: 2 }, lastFailure: { key: 'k', count: 2 }, blocks: 3, consecutiveBlocks: 2, receipts: { A: { architect: true } }, lastInstruction: 'x' })
  const clean = enterEnforce(state)
  expect(clean).toMatchObject({ attempts: {}, blocks: 0, consecutiveBlocks: 0, status: state.status, receipts: { A: { architect: true } }, lastInstruction: 'x', approvedHash: hash })
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

test('settling by checks skips a task missing a required receipt', () => {
  const { flow, hash } = chain()
  const state = approved(flow, hash, { status: { A: 'done', B: 'active', C: 'pending' }, blocks: 6 })
  const unreviewed = decide(flow, state, stopEvent({ A: [pass('A')], B: [pass('B')] }))
  expect(unreviewed.condition).toBe('budget')
  expect(unreviewed.state.status.B).toBe('active')
  expect(unreviewed.state.status.C).toBe('pending')
  const reviewed = decide(flow, { ...state, receipts: { B: { architect: true } } }, stopEvent({ A: [pass('A')], B: [pass('B')] }))
  expect(reviewed.state.status.B).toBe('done')
})

test('rebase keeps progress for surviving tasks, drops and remembers removed ones, adds new ones and keeps the approval', () => {
  const old = build([task('A'), task('B'), task('C')])
  const state = approved(old.flow, old.hash, {
    status: { A: 'done', B: 'active', C: 'pending' }, attempts: { A: 1, B: 1, C: 2 },
    receipts: { A: { architect: true }, C: { architect: true } }, awaiting: [{ task: 'B', by: 'architect' }, { task: 'C', by: 'qa' }], sideEffectsDone: ['C'], blocks: 2,
  })
  const next = build([task('A'), task('B'), task('N', { dependsOn: [] })])
  const rebased = rebase(next.flow, state)
  expect(rebased.hash).toBe(flowHash(next.flow))
  expect(rebased.hash).toBe(next.hash)
  // Enforcement stays: the person's approval is untouched and the new flow is recorded as adopted over it.
  expect(rebased.approvedHash).toBe(old.hash)
  expect(rebased.adoptedHash).toBe(next.hash)
  // Every id the plan has had is remembered, so a later amendment never reuses the one that was dropped.
  expect(rebased.seenIds).toEqual(['A', 'B', 'C', 'N'])
  expect(rebased.status).toEqual({ A: 'done', B: 'active', N: 'pending' })
  expect(rebased.attempts).toEqual({ A: 1, B: 1 })
  expect(rebased.receipts).toEqual({ A: { architect: true } })
  expect(rebased.awaiting).toEqual([])
  expect(rebased.sideEffectsDone).toEqual(['C'])
  expect(rebased.blocks).toBe(2)
  expect(state.status).toEqual({ A: 'done', B: 'active', C: 'pending' })
})

test('rebase re-picks an active task when none is left and the flow is still enforced', () => {
  const old = build([task('A'), task('B')])
  const state = approved(old.flow, old.hash, { status: { A: 'done', B: 'active' } })
  const next = build([task('A'), task('N')])
  const rebased = rebase(next.flow, state)
  expect(rebased.status).toEqual({ A: 'done', N: 'active' })
  expect(decide(next.flow, rebased, stopEvent()).condition).toBe('continue')
  // The old flow is no longer the one in force for this state.
  expect(decide(old.flow, rebased, stopEvent()).condition).toBe('unapproved')
})

test('rebase onto the approved flow itself leaves no adoption, and never approves a state nobody approved', () => {
  const { flow, hash } = chain()
  const same = rebase(flow, approved(flow, hash, { adoptedHash: 'stale', seenEdits: ['an edit'] }))
  expect(same.approvedHash).toBe(hash)
  expect(same.adoptedHash).toBeUndefined()
  expect(same.seenEdits).toBeUndefined()
  const bigger = build([task('A'), task('B', { risk: true }), task('C', { acceptance: { criteria: ['reads well'] } }), task('D', { dependsOn: ['C'] })])
  const none = rebase(bigger.flow, newState(flow, hash))
  expect(none.approvedHash).toBeUndefined()
  expect(none.adoptedHash).toBeUndefined()
  expect(decide(bigger.flow, none, stopEvent()).condition).toBe('unapproved')
  // The adoption chains: the second rebase keeps the person's approval, not the first adoption's hash.
  const first = rebase(bigger.flow, approved(flow, hash))
  const evenBigger = build([task('A'), task('B', { risk: true }), task('C', { acceptance: { criteria: ['reads well'] } }), task('D', { dependsOn: ['C'] }), task('E', { dependsOn: ['D'] })])
  const second = rebase(evenBigger.flow, first)
  expect(second).toMatchObject({ approvedHash: hash, adoptedHash: evenBigger.hash, hash: evenBigger.hash })
})

test('an adopted flow is enforced like an approved one, and a dropped task id is kept across rebases', () => {
  const old = build([task('A'), task('B')])
  const next = build([task('A'), task('B'), task('N', { dependsOn: ['B'] })])
  const state = rebase(next.flow, approved(old.flow, old.hash, { status: { A: 'done', B: 'active' } }))
  expect(state.adoptedHash).toBe(next.hash)
  const blocked = decide(next.flow, state, stopEvent({ B: [fail('B', 'broke')] }))
  expect(blocked).toMatchObject({ action: 'block', condition: 'check_failed', task: 'B' })
  expect(blocked.state).toMatchObject({ approvedHash: old.hash, adoptedHash: next.hash })
  // N is removed again by a later approval: its id stays on record.
  const gone = rebase(old.flow, state)
  expect(gone.seenIds).toEqual(['A', 'B', 'N'])
  expect(rebase(next.flow, gone).seenIds).toEqual(['A', 'B', 'N'])
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

test('a review on an unapproved, paused, stopped or done flow does not advance', () => {
  const { flow, hash } = chain()
  const base = { status: { A: 'done', B: 'active', C: 'pending' } as FlowState['status'], awaiting: [{ task: 'B', by: 'architect' as const }] }
  const cases: [string, FlowState][] = [
    ['unapproved', { ...newState(flow, hash), ...base }],
    ['paused', approved(flow, hash, { ...base, paused: true })],
    ['stopped', approved(flow, hash, { ...base, stopped: true })],
    ['already_done', approved(flow, hash, { ...base, done: true })],
  ]
  for (const [condition, state] of cases) {
    for (const verdict of ['pass', 'fail'] as const) {
      const decision = decide(flow, state, { kind: 'review', end: 0, taskId: 'B', by: 'architect', verdict })
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
  const state = approved(old.flow, old.hash, { status: { A: 'done', B: 'done', S: 'done' }, receipts: { B: { architect: true } }, sideEffectsDone: ['S'], done: true })
  const next = build([task('A', { risk: true }), task('B', { risk: true }), task('S', { risk: true, dependsOn: [] })])
  const rebased = rebase(next.flow, state)
  expect(rebased.status).toEqual({ A: 'active', B: 'done', S: 'done' })
  expect(rebased.receipts).toEqual({ B: { architect: true } })
})

// --- receipts: architect and QA ---

const QA_TASK = { acceptance: { checks: [check('Q')], criteria: ['shows the empty state', 'rejects a bad id'] } }
const qaFlow = () => build([task('Q', QA_TASK), task('N')])
const bothFlow = () => build([task('R', { risk: true, acceptance: { checks: [check('R')], criteria: ['works end to end'] } }), task('N')])
// `end` is the task's end count when the reviewer was spawned: 0 on a hand-built state, 1 after one passing task end.
const review = (taskId: string, by: 'architect' | 'qa', verdict: 'pass' | 'fail' | 'blocked', note?: string, end = 0): FlowEvent =>
  ({ kind: 'review', end, taskId, by, verdict, ...(note ? { note } : {}) }) as FlowEvent

test('requiredReceipts: architect for risk, qa for criteria or requireQa, never qa for a side effect', () => {
  const { flow } = build([
    task('A'), task('B', { risk: true }), task('C', { acceptance: { criteria: ['x'] } }),
    task('D', { risk: true, acceptance: { checks: [check('D')], criteria: ['x'] } }), task('E', { sideEffect: true }),
  ])
  // The plan refuses criteria and risk on a side effect; the policy still never asks QA to run one.
  const E = { ...flow.tasks[4]!, risk: true, acceptance: { checks: [check('E')], criteria: ['x'] } }
  const [A, B, C, D] = flow.tasks
  expect([A, B, C, D, E].map(t => requiredReceipts(t!))).toEqual([[], ['architect'], ['qa'], ['architect', 'qa'], ['architect']])
  expect(requiredReceipts(A!, {}, ['A'])).toEqual(['qa'])
  expect(requiredReceipts(E, {}, ['E'])).toEqual(['architect'])
  expect([A, B, E].map(t => requiredReceipts(t!, { requireQa: true }))).toEqual([['qa'], ['architect', 'qa'], ['architect']])
})

test('a task with criteria waits for QA at task end, then at the stop, and QA passing finishes it', () => {
  const { flow, hash } = qaFlow()
  const end = decide(flow, approved(flow, hash), endEvent('Q', [pass('Q')]))
  expect(end).toMatchObject({ action: 'allow', condition: 'qa_needed', task: 'Q' })
  expect(end.reason).toContain('qa')
  expect(end.state.status.Q).toBe('active')
  expect(end.state.awaiting).toEqual([{ task: 'Q', by: 'qa' }])
  expect(end.state.blocks).toBe(0)
  const stop = decide(flow, end.state, stopEvent({ Q: [pass('Q')] }))
  expect(stop).toMatchObject({ action: 'block', condition: 'qa_needed', task: 'Q' })
  expect(stop.reason).toContain('QA verdict')
  expect(stop.state.blocks).toBe(1)
  expect(stop.state.consecutiveBlocks).toBe(1)
  const done = decide(flow, end.state, review('Q', 'qa', 'pass', undefined, 1))
  expect(done).toMatchObject({ action: 'advance', condition: 'task_done', task: 'N' })
  expect(done.state.status).toEqual({ Q: 'done', N: 'active' })
  expect(done.state.receipts.Q).toEqual({ qa: true })
  expect(done.state.awaiting).toEqual([])
})

test('a task with criteria and no check at all still needs QA', () => {
  const { flow, hash } = build([task('A', { acceptance: { criteria: ['reads well'] } })])
  const end = decide(flow, approved(flow, hash), endEvent('A', []))
  expect(end).toMatchObject({ action: 'allow', condition: 'qa_needed' })
  expect(decide(flow, end.state, review('A', 'qa', 'pass', undefined, 1)).condition).toBe('all_done')
})

test('risk plus criteria needs both receipts, in either order', () => {
  const { flow, hash } = bothFlow()
  const end = decide(flow, approved(flow, hash), endEvent('R', [pass('R')]))
  expect(end).toMatchObject({ action: 'allow', condition: 'review_needed', task: 'R' })
  expect(end.reason).toContain('architect')
  expect(end.reason).toContain('qa')
  expect(end.state.awaiting).toEqual([{ task: 'R', by: 'architect' }, { task: 'R', by: 'qa' }])
  const stop = decide(flow, end.state, stopEvent({ R: [pass('R')] }))
  expect(stop).toMatchObject({ action: 'block', condition: 'review_needed' })
  expect(stop.reason).toContain('no architect review and no QA verdict')

  const final = (first: 'architect' | 'qa', second: 'architect' | 'qa') => {
    const one = decide(flow, end.state, review('R', first, 'pass', undefined, 1))
    expect(one).toMatchObject({ action: 'allow', condition: second === 'qa' ? 'qa_needed' : 'review_needed', task: 'R' })
    expect(one.state.status.R).toBe('active')
    expect(one.state.awaiting).toEqual([{ task: 'R', by: second }])
    expect(one.state.receipts.R).toEqual({ [first]: true })
    return decide(flow, one.state, review('R', second, 'pass', undefined, 1))
  }
  const ab = final('architect', 'qa')
  const ba = final('qa', 'architect')
  for (const result of [ab, ba]) {
    expect(result).toMatchObject({ action: 'advance', condition: 'task_done', task: 'N' })
    expect(result.state.status).toEqual({ R: 'done', N: 'active' })
    expect(result.state.receipts).toEqual({ R: { architect: true, qa: true } })
    expect(result.state.awaiting).toEqual([])
  }
  expect(ab.state.status).toEqual(ba.state.status)
  expect(ab.state.receipts).toEqual(ba.state.receipts)
})

test('an architect approval of a task that also needs QA adds the QA wait when it was not already waiting', () => {
  const { flow, hash } = bothFlow()
  const legacy = approved(flow, hash, { awaiting: [{ task: 'R', by: 'architect' }] })
  const one = decide(flow, legacy, review('R', 'architect', 'pass'))
  expect(one).toMatchObject({ action: 'allow', condition: 'qa_needed' })
  expect(one.state.awaiting).toEqual([{ task: 'R', by: 'qa' }])
})

test('settling by checks never finishes a task that is missing a receipt', () => {
  const both = bothFlow()
  const qa = qaFlow()
  const cases: [string, { flow: Flow; hash: string }, Record<string, CheckResult[]>, Partial<FlowState>, 'active' | 'done'][] = [
    ['no receipt', qa, { Q: [pass('Q')] }, {}, 'active'],
    ['qa receipt', qa, { Q: [pass('Q')] }, { receipts: { Q: { qa: true } } }, 'done'],
    ['only the architect receipt', both, { R: [pass('R')] }, { receipts: { R: { architect: true } } }, 'active'],
    ['only the qa receipt', both, { R: [pass('R')] }, { receipts: { R: { qa: true } } }, 'active'],
    ['both receipts', both, { R: [pass('R')] }, { receipts: { R: { architect: true, qa: true } } }, 'done'],
  ]
  for (const [name, { flow, hash }, checks, patch, expected] of cases) {
    const id = flow.tasks[0]!.id
    const decision = decide(flow, approved(flow, hash, { blocks: 6, ...patch }), stopEvent(checks))
    expect({ name, status: decision.state.status[id] }).toEqual({ name, status: expected })
    if (expected === 'active') expect({ name, condition: decision.condition }).toEqual({ name, condition: 'budget' })
  }
  // The consecutive-cap budget path settles the same way.
  const capped = decide(qa.flow, approved(qa.flow, qa.hash, { blocks: 2, consecutiveBlocks: 7 }), stopEvent({ Q: [pass('Q')] }, { stopHookActive: true }))
  expect(capped.condition).toBe('budget')
  expect(capped.state.status.Q).toBe('active')
})

test('requireQa makes a checks-only task wait for QA, and only then', () => {
  const { flow, hash } = build([task('A'), task('S', { sideEffect: true, dependsOn: [] })])
  const plain = decide(flow, approved(flow, hash), endEvent('A', [pass('A')]))
  expect(plain).toMatchObject({ action: 'advance', condition: 'task_done' })
  const strict = decide(flow, approved(flow, hash), endEvent('A', [pass('A')]), undefined, { requireQa: true, available: ALL })
  expect(strict).toMatchObject({ action: 'allow', condition: 'qa_needed', task: 'A' })
  expect(strict.state.status.A).toBe('active')
  expect(strict.state.awaiting).toEqual([{ task: 'A', by: 'qa' }])
  // Never on a side-effect task.
  const side = decide(flow, approved(flow, hash, { status: { A: 'done', S: 'active' } }), endEvent('S', [pass('S')]), undefined, { requireQa: true, available: ALL })
  expect(side.condition).not.toBe('qa_needed')
  expect(side.state.status.S).toBe('done')
  // Settling by checks honors it too.
  const settled = decide(flow, approved(flow, hash, { blocks: 6 }), stopEvent({ A: [pass('A')] }), undefined, { requireQa: true, available: ALL })
  expect(settled.state.status.A).toBe('active')
  expect(decide(flow, approved(flow, hash, { blocks: 6 }), stopEvent({ A: [pass('A')] })).state.status.A).toBe('done')
  // The stricter second pass is a pure function of the state: the first decision is unchanged.
  expect(plain.state.status.A).toBe('done')
})

test('a QA fail is a failed attempt that clears the receipts and walks the retry ladder', () => {
  const { flow, hash } = bothFlow()
  const waiting = approved(flow, hash, { awaiting: [{ task: 'R', by: 'qa' }], receipts: { R: { architect: true } } })
  const one = decide(flow, waiting, review('R', 'qa', 'fail', 'the empty state is blank'))
  expect(one).toMatchObject({ action: 'failTask', condition: 'retry', task: 'R' })
  expect(one.reason).toContain('the empty state is blank')
  expect(one.reason).toContain('QA failed')
  expect(one.state.attempts.R).toBe(1)
  expect(one.state.awaiting).toEqual([])
  expect(one.state.receipts.R).toBeUndefined()
  expect(one.state.status.R).toBe('active')
  // Bounded: the next fails go to the architect, then to the person.
  const again = decide(flow, { ...one.state, awaiting: [{ task: 'R', by: 'qa' }] }, review('R', 'qa', 'fail'))
  expect(again).toMatchObject({ action: 'failTask', condition: 'architect' })
  const last = decide(flow, { ...again.state, awaiting: [{ task: 'R', by: 'qa' }] }, review('R', 'qa', 'fail'))
  expect(last).toMatchObject({ action: 'pause', condition: 'ask_person' })
  // After a fail the task needs both receipts again.
  const back = decide(flow, one.state, endEvent('R', [pass('R')]))
  expect(back.state.awaiting).toEqual([{ task: 'R', by: 'architect' }, { task: 'R', by: 'qa' }])
})

test('a QA fail on a task with onFail moves to the branch', () => {
  const { flow, hash } = build([task('A', { onFail: 'D', acceptance: { checks: [check('A')], criteria: ['x'] } }), task('D', { dependsOn: [] })])
  const waiting = approved(flow, hash, { awaiting: [{ task: 'A', by: 'qa' }], attempts: { A: 1 } })
  expect(decide(flow, waiting, review('A', 'qa', 'fail'))).toMatchObject({ action: 'advance', condition: 'on_fail', task: 'D' })
})

test('a review for the wrong reviewer is ignored and leaves the state as it was', () => {
  const { flow, hash } = bothFlow()
  const onlyQa = approved(flow, hash, { awaiting: [{ task: 'R', by: 'qa' }], receipts: { R: { architect: true } } })
  for (const verdict of ['pass', 'fail'] as const) {
    const decision = decide(flow, onlyQa, review('R', 'architect', verdict))
    expect(decision).toMatchObject({ action: 'allow', condition: 'review_ignored' })
    expect(decision.state).toEqual(onlyQa)
  }
  // A receipt already given cannot be given again.
  const again = decide(flow, decide(flow, onlyQa, review('R', 'qa', 'pass')).state, review('R', 'qa', 'pass'))
  expect(again.condition).toBe('review_ignored')
})

test('a disabled role that is needed pauses and asks the person, it never blocks', () => {
  const { flow, hash } = bothFlow()
  const qaGone = { available: { qa: false, architect: true } }
  const end = decide(flow, approved(flow, hash), endEvent('R', [pass('R')]), undefined, qaGone)
  expect(end).toMatchObject({ action: 'pause', condition: 'role_unavailable', task: 'R' })
  expect(end.reason).toContain('qa is disabled')
  expect(end.reason).toContain('enable it in pantheon.json and /pantheon flow resume, or /pantheon flow stop')
  expect(end.state.paused).toBe(true)
  expect(end.state.status.R).toBe('active')
  expect(end.state.awaiting).toEqual([{ task: 'R', by: 'architect' }, { task: 'R', by: 'qa' }])
  expect(end.state.lastInstruction).toBe(end.reason)

  const waiting = approved(flow, hash, { awaiting: [{ task: 'R', by: 'architect' }] })
  const stop = decide(flow, waiting, stopEvent({ R: [pass('R')] }), undefined, { available: { qa: true, architect: false } })
  expect(stop).toMatchObject({ action: 'pause', condition: 'role_unavailable', task: 'R' })
  expect(stop.reason).toContain('the architect is disabled')
  expect(stop.state.blocks).toBe(0)
  expect(stop.state.paused).toBe(true)
  // A paused flow lets the session stop.
  expect(decide(flow, stop.state, stopEvent({ R: [pass('R')] }), undefined, { available: { qa: true, architect: false } }).condition).toBe('paused')

  // Available roles, or nothing said about availability, change nothing.
  const open = decide(flow, approved(flow, hash), endEvent('R', [pass('R')]), undefined, { available: { qa: true, architect: true } })
  expect(open.condition).toBe('review_needed')
  expect(decide(flow, approved(flow, hash), endEvent('R', [pass('R')])).condition).toBe('review_needed')
  // A disabled role nobody needs is fine.
  const plain = build([task('A')])
  expect(decide(plain.flow, approved(plain.flow, plain.hash), endEvent('A', [pass('A')]), undefined, { available: { qa: false, architect: false } }).condition).toBe('all_done')
})

test('a disabled architect cannot diagnose: the exhausted ladder pauses with role_unavailable', () => {
  const { flow, hash } = chain()
  const gone = { available: { qa: true, architect: false } }
  const decision = decide(flow, approved(flow, hash, { attempts: { A: 1 } }), endEvent('A', [fail('A', 'nope')]), undefined, gone)
  expect(decision).toMatchObject({ action: 'pause', condition: 'role_unavailable' })
  expect(decision.reason).toContain('nope')
  expect(decision.state.paused).toBe(true)
  expect(decide(flow, approved(flow, hash), endEvent('A', [fail('A')]), undefined, gone).condition).toBe('retry')
})

test('a regression of a done task clears its receipts, so it needs them again', () => {
  const { flow, hash } = bothFlow()
  const done = approved(flow, hash, {
    status: { R: 'done', N: 'active' }, receipts: { R: { architect: true, qa: true } }, attempts: { R: 1 },
  })
  const back = decide(flow, done, stopEvent({ R: [fail('R', 'R broke')] }))
  expect(back).toMatchObject({ action: 'block', condition: 'regression', task: 'R' })
  expect(back.state.status).toEqual({ R: 'active', N: 'pending' })
  expect(back.state.receipts).toEqual({})
  expect(back.state.awaiting).toEqual([])
  const again = decide(flow, back.state, endEvent('R', [pass('R')]))
  expect(again).toMatchObject({ action: 'allow', condition: 'review_needed' })
  expect(again.state.status.R).toBe('active')
  expect(again.state.awaiting).toEqual([{ task: 'R', by: 'architect' }, { task: 'R', by: 'qa' }])
})

test('a regression also drops the receipts of work started on top of the broken task', () => {
  const { flow, hash } = build([task('A'), task('B', { acceptance: { checks: [check('B')], criteria: ['x'] } })])
  const state = approved(flow, hash, { status: { A: 'done', B: 'active' }, receipts: { B: { qa: true } }, awaiting: [{ task: 'B', by: 'qa' }] })
  const back = decide(flow, state, stopEvent({ A: [fail('A')] }))
  expect(back.state.status).toEqual({ A: 'active', B: 'pending' })
  expect(back.state.receipts).toEqual({})
  expect(back.state.awaiting).toEqual([])
})

test('rebase keeps receipts only for surviving tasks and sends back a done task that now needs one', () => {
  const old = build([task('A'), task('B'), task('S', { dependsOn: [] })])
  const state = approved(old.flow, old.hash, {
    status: { A: 'done', B: 'done', S: 'done' }, receipts: { A: { architect: true }, B: { qa: true } }, sideEffectsDone: ['S'], done: true,
  })
  // A gains criteria and has no qa receipt; B gains criteria and has one; S gains criteria but its side effect already ran.
  const next = build([
    task('A', { acceptance: { checks: [check('A')], criteria: ['x'] } }), task('B', { acceptance: { checks: [check('B')], criteria: ['x'] } }),
    task('S', { dependsOn: [], acceptance: { checks: [check('S')], criteria: ['x'] } }),
  ])
  const rebased = rebase(next.flow, state)
  expect(rebased.status).toEqual({ A: 'active', B: 'done', S: 'done' })
  expect(rebased.receipts).toEqual({ A: { architect: true }, B: { qa: true } })
  // Removed tasks lose their receipts and waits; a wait nobody requires any more is dropped.
  const gone = approved(old.flow, old.hash, {
    status: { A: 'active', B: 'active', S: 'pending' }, receipts: { S: { architect: true } },
    awaiting: [{ task: 'A', by: 'architect' }, { task: 'B', by: 'qa' }, { task: 'S', by: 'qa' }],
  })
  const shrunk = rebase(build([task('A', { risk: true }), task('B')]).flow, gone)
  expect(shrunk.awaiting).toEqual([{ task: 'A', by: 'architect' }])
  expect(shrunk.receipts).toEqual({})
  expect(gone.awaiting).toHaveLength(3)
})

test('shadow restores the receipts and waits of work it would have sent back, but keeps the attempt', () => {
  const { flow, hash } = bothFlow()
  const previous = approved(flow, hash, { awaiting: [{ task: 'R', by: 'qa' }], receipts: { R: { architect: true } } })
  const failed = applyMode(decide(flow, previous, review('R', 'qa', 'fail')), 'shadow', previous)
  expect(failed.wouldBe).toMatchObject({ action: 'failTask', condition: 'retry' })
  expect(failed.state.awaiting).toEqual(previous.awaiting)
  expect(failed.state.receipts).toEqual(previous.receipts)
  expect(failed.state.attempts.R).toBe(1)
  // Real progress (a task finishing) keeps the new receipts.
  const passed = applyMode(decide(flow, previous, review('R', 'qa', 'pass')), 'shadow', previous)
  expect(passed.wouldBe?.condition).toBe('task_done')
  expect(passed.state.status.R).toBe('done')
  expect(passed.state.receipts.R).toEqual({ architect: true, qa: true })
  // A pause (a disabled role) is not applied in shadow either.
  const paused = applyMode(decide(flow, approved(flow, hash), endEvent('R', [pass('R')]), undefined, { available: { qa: false, architect: true } }), 'shadow', approved(flow, hash))
  expect(paused.wouldBe?.condition).toBe('role_unavailable')
  expect(paused.state.paused).toBe(false)
  expect(paused.state.awaiting).toEqual([])
})

test('opts never change what a judgment cannot: a judgment still has no effect with opts', () => {
  const { flow, hash } = qaFlow()
  const opts = { requireQa: true, available: { qa: true, architect: true } }
  const base = decide(flow, approved(flow, hash), endEvent('Q', [pass('Q')]), undefined, opts)
  const judged = decide(flow, approved(flow, hash), endEvent('Q', [pass('Q')]), { source: 'jev', scores: { complete: 0.99, claimsDone: 0.99, stuck: 0 } }, opts)
  expect(judged).toEqual(base)
})

test('decide with qa receipts never mutates its input', () => {
  const { flow, hash } = bothFlow()
  const state = approved(flow, hash, { awaiting: [{ task: 'R', by: 'qa' }], receipts: { R: { architect: true } } })
  for (const event of [review('R', 'qa', 'pass'), review('R', 'qa', 'fail'), endEvent('R', [pass('R')]), stopEvent({ R: [pass('R')] })]) {
    const before = clone({ flow, state, event })
    decide(deepFreeze(clone(flow)), deepFreeze(clone(state)), deepFreeze(clone(event)), undefined, deepFreeze({ requireQa: true, available: { qa: false, architect: false } }))
    expect(clone({ flow, state, event })).toEqual(before)
  }
})

// --- receipts: escalation, deliveries, blocked, enforcement edges ---

test('a requireQa escalation sticks: settle-by-checks, a later task end and rebase all still wait for QA', () => {
  const { flow, hash } = build([task('A'), task('B')])
  const strict = decide(flow, approved(flow, hash), endEvent('A', [pass('A')]), undefined, { requireQa: true, available: ALL })
  expect(strict.state.qaRequired).toEqual(['A'])
  // The budget runs out and the next call knows nothing of the escalation: the task is still not settled.
  const settled = decide(flow, { ...strict.state, blocks: 6 }, stopEvent({ A: [pass('A')] }))
  expect(settled).toMatchObject({ condition: 'budget' })
  expect(settled.state.status.A).toBe('active')
  expect(settled.reason).toContain('Awaiting receipts: A (qa)')
  // The agent delivers again without the escalation in the options: QA is still required.
  const again = decide(flow, strict.state, endEvent('A', [pass('A')]))
  expect(again).toMatchObject({ action: 'allow', condition: 'qa_needed' })
  // A plan edit keeps the requirement; a task that is removed loses it.
  expect(rebase(flow, strict.state).qaRequired).toEqual(['A'])
  expect(rebase(build([task('B')]).flow, strict.state).qaRequired).toEqual([])
  // A done task with the escalation but no receipt goes back.
  const rebased = rebase(flow, { ...strict.state, status: { A: 'done', B: 'active' }, receipts: {}, awaiting: [] })
  expect(rebased.status.A).not.toBe('done')
  // QA passing finishes it and drops the escalation.
  const done = decide(flow, strict.state, review('A', 'qa', 'pass', undefined, 1))
  expect(done.state.status.A).toBe('done')
  expect(done.state.qaRequired).toEqual([])
})

test('requireQa on a side-effect task changes nothing and says so', () => {
  const { flow, hash } = build([task('S', { sideEffect: true })])
  const decision = decide(flow, approved(flow, hash), endEvent('S', [pass('S')]), undefined, { requireQa: true, available: ALL })
  expect(decision).toMatchObject({ condition: 'all_done', note: 'require_qa_ignored' })
  expect(decision.state.qaRequired).toEqual([])
  expect(decision.state.status.S).toBe('done')
  expect(decide(flow, approved(flow, hash), endEvent('S', [pass('S')])).note).toBeUndefined()
})

test('a new delivery drops the receipts earned for older code', () => {
  const { flow, hash } = bothFlow()
  const first = decide(flow, approved(flow, hash), endEvent('R', [pass('R')]))
  expect(first.state.ends.R).toBe(1)
  const approvedByArchitect = decide(flow, first.state, review('R', 'architect', 'pass', undefined, 1))
  expect(approvedByArchitect.state.receipts.R).toEqual({ architect: true })
  // The developer re-delivers: the architect's receipt covered the old code.
  const second = decide(flow, approvedByArchitect.state, endEvent('R', [pass('R')]))
  expect(second.state.ends.R).toBe(2)
  expect(second.state.receipts.R).toBeUndefined()
  expect(second.state.awaiting).toEqual([{ task: 'R', by: 'architect' }, { task: 'R', by: 'qa' }])
  // QA verifies the new code, but the architect has not seen it.
  const qa = decide(flow, second.state, review('R', 'qa', 'pass', undefined, 2))
  expect(qa).toMatchObject({ action: 'allow', condition: 'review_needed' })
  expect(qa.state.status.R).toBe('active')
  expect(qa.state.awaiting).toEqual([{ task: 'R', by: 'architect' }])
  // A verdict about the old delivery is ignored, whichever reviewer gives it.
  for (const by of ['architect', 'qa'] as const) {
    const stale = decide(flow, second.state, review('R', by, 'pass', undefined, 1))
    expect(stale).toMatchObject({ action: 'allow', condition: 'review_ignored' })
    expect(stale.state).toEqual(second.state)
  }
  expect(decide(flow, second.state, review('R', 'qa', 'fail', undefined, 1)).condition).toBe('review_ignored')
  // A failing delivery counts too.
  const failing = decide(flow, second.state, endEvent('R', [fail('R')]))
  expect(failing.state.ends.R).toBe(3)
})

test('a QA verdict of blocked pauses and asks the person without spending an attempt', () => {
  const { flow, hash } = qaFlow()
  const waiting = approved(flow, hash, { awaiting: [{ task: 'Q', by: 'qa' }], attempts: { Q: 1 } })
  const blocked = decide(flow, waiting, review('Q', 'qa', 'blocked', 'no database to run against'))
  expect(blocked).toMatchObject({ action: 'pause', condition: 'qa_blocked', task: 'Q' })
  expect(blocked.reason).toContain('no database to run against')
  expect(blocked.reason).toContain('no attempt was spent')
  expect(blocked.state.paused).toBe(true)
  expect(blocked.state.attempts.Q).toBe(1)
  expect(blocked.state.awaiting).toEqual([{ task: 'Q', by: 'qa' }])
  expect(blocked.state.status.Q).toBe('active')
  // A stale or unexpected blocked verdict is ignored like any other.
  expect(decide(flow, waiting, review('Q', 'qa', 'blocked', undefined, 5)).condition).toBe('review_ignored')
  expect(decide(flow, approved(flow, hash), review('Q', 'qa', 'blocked')).condition).toBe('review_ignored')
})

test('a task awaiting a receipt while agents still run waits without spending budget', () => {
  const { flow, hash } = qaFlow()
  const waiting = approved(flow, hash, { awaiting: [{ task: 'Q', by: 'qa' }], blocks: 2, consecutiveBlocks: 2 })
  const decision = decide(flow, waiting, stopEvent({ Q: [pass('Q')] }, { runningAgents: 1, stopHookActive: true }))
  expect(decision).toMatchObject({ action: 'wait', condition: 'waiting' })
  expect(decision.state.blocks).toBe(2)
  expect(decision.state.consecutiveBlocks).toBe(0)
  expect(decision.state.awaiting).toEqual(waiting.awaiting)
})

test('a failing check on a task that is only awaiting a receipt still blocks and clears it', () => {
  const { flow, hash } = build([task('cli', { dependsOn: [] }), task('docs', { dependsOn: [], acceptance: { checks: [check('docs')], criteria: ['x'] } })])
  const state = approved(flow, hash, { status: { cli: 'active', docs: 'pending' }, awaiting: [{ task: 'docs', by: 'qa' }] })
  const decision = decide(flow, state, stopEvent({ cli: [pass('cli')], docs: [fail('docs', 'docs broke')] }))
  expect(decision).toMatchObject({ action: 'block', condition: 'check_failed', task: 'docs' })
  expect(decision.state.awaiting).toEqual([])
})

test('entering enforce clears the waits and receipts of tasks that are not done', () => {
  const { flow, hash } = bothFlow()
  const state = approved(flow, hash, {
    status: { R: 'active', N: 'done' }, awaiting: [{ task: 'R', by: 'qa' }, { task: 'N', by: 'qa' }],
    receipts: { R: { architect: true }, N: { qa: true } }, mode: 'shadow',
  })
  for (const clean of [enterEnforce(state), withMode(state, 'enforce')]) {
    expect(clean.awaiting).toEqual([{ task: 'N', by: 'qa' }])
    expect(clean.receipts).toEqual({ N: { qa: true } })
  }
  expect(state.awaiting).toHaveLength(2)
  expect(withMode(state, 'shadow').awaiting).toHaveLength(2)
})

test('a delivery during a pause or a stop still counts and clears the older receipts', () => {
  const { flow, hash } = bothFlow()
  const delivered = decide(flow, approved(flow, hash), endEvent('R', [pass('R')]))
  const architect = decide(flow, delivered.state, review('R', 'architect', 'pass', undefined, 1))
  const blocked = decide(flow, architect.state, review('R', 'qa', 'blocked', 'no database', 1))
  expect(blocked).toMatchObject({ action: 'pause', condition: 'qa_blocked' })
  expect(blocked.state.receipts.R).toEqual({ architect: true })
  // The developer re-delivers while the flow is paused: nothing advances, but the old receipts are gone.
  const during = decide(flow, blocked.state, endEvent('R', [pass('R')]))
  expect(during).toMatchObject({ action: 'allow', condition: 'paused' })
  expect(during.state.paused).toBe(true)
  expect(during.state.ends.R).toBe(2)
  expect(during.state.receipts).toEqual({})
  expect(during.state.awaiting).toEqual([])
  expect(during.state.status.R).toBe('active')
  expect(blocked.state.ends.R).toBe(1)
  // The person resumes. QA's verdict is about the old delivery and is ignored.
  const resumed = { ...during.state, paused: false }
  const stale = decide(flow, resumed, review('R', 'qa', 'pass', undefined, 1))
  expect(stale.condition).toBe('review_ignored')
  expect(stale.state).toEqual(resumed)
  // The next delivery asks for both receipts again.
  const again = decide(flow, resumed, endEvent('R', [pass('R')]))
  expect(again.state.awaiting).toEqual([{ task: 'R', by: 'architect' }, { task: 'R', by: 'qa' }])
  expect(again.state.receipts).toEqual({})
  // The same for a stop, and a done task or an unknown one is left alone.
  const stopped = decide(flow, { ...architect.state, stopped: true }, endEvent('R', [pass('R')]))
  expect(stopped).toMatchObject({ condition: 'stopped' })
  expect(stopped.state.receipts).toEqual({})
  const done = approved(flow, hash, { paused: true, status: { R: 'done', N: 'active' }, receipts: { R: { architect: true, qa: true } } })
  expect(decide(flow, done, endEvent('R', [pass('R')])).state).toEqual(done)
  expect(decide(flow, done, endEvent('ghost', [pass('R')])).state).toEqual(done)
})

// --- escalations: the judge's second decision (decision 18) ---

test('retryToArchitect sends a failing retry to the architect now and sets the attempts to the limit', () => {
  const { flow, hash } = build([task('A')], { maxAttempts: 3 })
  const state = approved(flow, hash)
  const plain = decide(flow, state, endEvent('A', [fail('A', 'expected 2 got 3')]))
  expect(plain).toMatchObject({ action: 'failTask', condition: 'retry', task: 'A' })
  expect(plain.state.attempts.A).toBe(1)
  const escalated = decide(flow, state, endEvent('A', [fail('A', 'expected 2 got 3')]), undefined, { retryToArchitect: true, available: ALL })
  expect(escalated).toMatchObject({ action: 'failTask', condition: 'architect', task: 'A' })
  expect(escalated.reason).toContain('expected 2 got 3')
  expect(escalated.reason).toContain('architect')
  expect(escalated.state.attempts.A).toBe(3)
  expect(escalated.state.status.A).toBe('active')
  expect(escalated.state.lastInstruction).toBe(escalated.reason)
  // The ladder continues as after the last attempt: one more try after the diagnosis, then the person.
  const again = decide(flow, escalated.state, endEvent('A', [fail('A', 'again')]))
  expect(again).toMatchObject({ action: 'pause', condition: 'ask_person' })
})

test('retryToArchitect never advances, pauses or overrides: an onFail branch, a disabled architect and ownership keep the ladder', () => {
  const branch = build([task('A', { onFail: 'F' }), task('F', { dependsOn: [] })], { maxAttempts: 3 })
  const onFail = decide(branch.flow, approved(branch.flow, branch.hash), endEvent('A', [fail('A')]), undefined, { retryToArchitect: true, available: ALL })
  expect(onFail).toMatchObject({ action: 'failTask', condition: 'retry', note: 'retry_to_architect_ignored' })
  expect(onFail.state.attempts.A).toBe(1)
  expect(onFail.state.status.F).toBe('pending')

  const { flow, hash } = build([task('A')], { maxAttempts: 3 })
  const gone = decide(flow, approved(flow, hash), endEvent('A', [fail('A')]), undefined, { retryToArchitect: true, available: { qa: true, architect: false } })
  expect(gone).toMatchObject({ action: 'failTask', condition: 'retry', note: 'retry_to_architect_ignored' })
  expect(gone.state.paused).toBe(false)
  expect(gone.state.attempts.A).toBe(1)

  // A delivery that wrote outside its files is the ownership rung, whatever the judge thinks.
  const owned = decide(flow, approved(flow, hash), endEvent('A', [pass('A')], 2), undefined, { retryToArchitect: true, available: ALL })
  expect(owned).toMatchObject({ action: 'failTask', condition: 'ownership' })
  expect(owned.note).toBeUndefined()
  expect(owned.state.attempts.A).toBe(1)

  // Past the limit, or at it, the policy already did what the escalation asks.
  const last = decide(flow, approved(flow, hash, { attempts: { A: 2 } }), endEvent('A', [fail('A')]), undefined, { retryToArchitect: true, available: ALL })
  const lastPlain = decide(flow, approved(flow, hash, { attempts: { A: 2 } }), endEvent('A', [fail('A')]))
  expect(last).toEqual(lastPlain)
  const over = decide(flow, approved(flow, hash, { attempts: { A: 3 } }), endEvent('A', [fail('A')]), undefined, { retryToArchitect: true, available: ALL })
  expect(over).toMatchObject({ action: 'pause', condition: 'ask_person' })

  // It means nothing for a passing delivery, a stop or a human prompt.
  const passing = decide(flow, approved(flow, hash), endEvent('A', [pass('A')]), undefined, { retryToArchitect: true, available: ALL })
  expect(passing).toEqual(decide(flow, approved(flow, hash), endEvent('A', [pass('A')])))
  const stopped = decide(flow, approved(flow, hash), stopEvent({ A: [fail('A')] }), undefined, { retryToArchitect: true, available: ALL })
  expect(stopped).toEqual(decide(flow, approved(flow, hash), stopEvent({ A: [fail('A')] })))
})

test('retryToArchitect also escalates a QA failure, which goes through the same ladder', () => {
  const { flow, hash } = build([task('Q', { acceptance: { checks: [check('Q')], criteria: ['works'] } })], { maxAttempts: 3 })
  const waiting = approved(flow, hash, { awaiting: [{ task: 'Q', by: 'qa' }] })
  const plain = decide(flow, waiting, review('Q', 'qa', 'fail', 'C1 fails'))
  const escalated = decide(flow, waiting, review('Q', 'qa', 'fail', 'C1 fails'), undefined, { retryToArchitect: true, available: ALL })
  expect(plain).toMatchObject({ action: 'failTask', condition: 'retry' })
  expect(escalated).toMatchObject({ action: 'failTask', condition: 'architect' })
  expect(escalated.state.attempts.Q).toBe(3)
  expect(escalated.state.receipts.Q).toBeUndefined()
})

test('requireQa never turns a pause into a wait, and with QA disabled there is nobody to escalate to', () => {
  // A risky task whose architect is disabled pauses; the escalation leaves that pause exactly as it was (no QA requirement is
  // recorded, nothing else is asked for), instead of making it a wait.
  const risky = build([task('R', { risk: true })])
  const gone = { qa: true, architect: false }
  const plain = decide(risky.flow, approved(risky.flow, risky.hash), endEvent('R', [pass('R')]), undefined, { available: gone })
  const strict = decide(risky.flow, approved(risky.flow, risky.hash), endEvent('R', [pass('R')]), undefined, { requireQa: true, available: gone })
  expect(plain).toMatchObject({ action: 'pause', condition: 'role_unavailable' })
  expect(strict).toEqual(plain)
  expect(strict.state.qaRequired).toEqual([])

  // QA disabled: nobody to escalate to; the flow is not paused for it.
  const { flow, hash } = build([task('A'), task('B')])
  const offline = decide(flow, approved(flow, hash), endEvent('A', [pass('A')]), undefined, { requireQa: true, available: { qa: false, architect: true } })
  expect(offline).toMatchObject({ action: 'advance', condition: 'task_done', note: 'require_qa_ignored' })
  expect(offline.state.qaRequired).toEqual([])
  expect(offline.state.awaiting).toEqual([])
})

test('requireQa on a risk task adds QA to the architect\'s review, and where QA is already required it changes nothing', () => {
  const risky = build([task('R', { risk: true })])
  const both = decide(risky.flow, approved(risky.flow, risky.hash), endEvent('R', [pass('R')]), undefined, { requireQa: true, available: ALL })
  expect(both).toMatchObject({ action: 'allow', condition: 'review_needed' })
  expect(both.state.awaiting).toEqual([{ task: 'R', by: 'architect' }, { task: 'R', by: 'qa' }])
  const criteria = build([task('Q', { acceptance: { checks: [check('Q')], criteria: ['x'] } })])
  const already = decide(criteria.flow, approved(criteria.flow, criteria.hash), endEvent('Q', [pass('Q')]), undefined, { requireQa: true, available: ALL })
  expect(already).toEqual(decide(criteria.flow, approved(criteria.flow, criteria.hash), endEvent('Q', [pass('Q')])))
})

test('rebase and entering enforce keep the failing output only for tasks still there, and the attempts starting over drop it', () => {
  const { flow, hash } = build([task('A'), task('B')])
  const state = approved(flow, hash, { lastOutput: { A: 'x', B: 'y', gone: 'z' } })
  const smaller = build([task('A')])
  expect(rebase(smaller.flow, state).lastOutput).toEqual({ A: 'x' })
  expect(rebase(build([task('Z')]).flow, state).lastOutput).toBeUndefined()
  expect(enterEnforce(state).lastOutput).toBeUndefined()
  expect(state.lastOutput).toEqual({ A: 'x', B: 'y', gone: 'z' })
})

// Two-pass property tests (decision 18): the escalated decision is a second `decide` over the same inputs, and whatever the
// judge says it can only be stricter.

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
const choose = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!

function randomFlow(rand: () => number): { flow: Flow; hash: string } | undefined {
  const count = 1 + Math.floor(rand() * 4)
  const ids = ['A', 'B', 'C', 'D'].slice(0, count)
  const tasks = ids.map((id, index) => {
    const hasChecks = rand() < 0.85
    const criteria = !hasChecks || rand() < 0.3 ? { criteria: ['it works'] } : {}
    const others = ids.filter(other => other !== id)
    return task(id, {
      ...(rand() < 0.3 ? { risk: true } : {}),
      ...(rand() < 0.2 ? { sideEffect: true } : {}),
      ...(index > 0 && rand() < 0.3 ? { dependsOn: [] } : {}),
      ...(others.length > 0 && rand() < 0.15 ? { onFail: choose(rand, others) } : {}),
      acceptance: { checks: hasChecks ? [check(id)] : [], ...criteria },
    })
  })
  try { return build(tasks, { maxAttempts: 1 + Math.floor(rand() * 4), maxBlocks: 1 + Math.floor(rand() * 7) }) } catch { return undefined }
}

function randomState(rand: () => number, flow: Flow, hash: string): FlowState {
  const ids = flow.tasks.map(t => t.id)
  const status = Object.fromEntries(ids.map(id => [id, choose(rand, ['pending', 'active', 'active', 'done', 'failed'] as const)]))
  const awaiting = ids.flatMap(id => (rand() < 0.25 ? [{ task: id, by: choose(rand, ['qa', 'architect'] as const) }] : []))
  const receipts = Object.fromEntries(ids.flatMap(id => (rand() < 0.2 ? [[id, rand() < 0.5 ? { qa: true as const } : { architect: true as const }]] : [])))
  return {
    ...newState(flow, hash), approvedHash: hash, status, awaiting, receipts,
    attempts: Object.fromEntries(ids.flatMap(id => (rand() < 0.5 ? [[id, Math.floor(rand() * 4)]] : []))),
    qaRequired: ids.filter(() => rand() < 0.15),
    ends: Object.fromEntries(ids.map(id => [id, Math.floor(rand() * 3)])),
    blocks: Math.floor(rand() * 7), consecutiveBlocks: Math.floor(rand() * 8),
    paused: rand() < 0.1, stopped: rand() < 0.05, done: rand() < 0.05,
  }
}

function randomEvent(rand: () => number, flow: Flow, state: FlowState): FlowEvent {
  const resultsFor = (id: string): CheckResult[] => {
    const declared = flow.tasks.find(t => t.id === id)!.acceptance.checks.length
    const count = rand() < 0.1 ? Math.max(0, declared - 1) : declared
    return Array.from({ length: count }, () => (rand() < 0.6 ? pass(id) : rand() < 0.7 ? fail(id, 'FAIL') : rand() < 0.5 ? { argv: ['run', id], passed: null, output: 'timed out' } : { argv: ['run', id], passed: null, output: 'working directory x does not exist', couldNotRun: true }))
  }
  const ids = flow.tasks.map(t => t.id)
  const kind = rand()
  if (kind < 0.55) {
    const id = choose(rand, ids)
    return endEvent(id, resultsFor(id), rand() < 0.1 ? 1 : 0)
  }
  if (kind < 0.8) {
    return stopEvent(Object.fromEntries(ids.filter(() => rand() < 0.8).map(id => [id, resultsFor(id)])), {
      stopHookActive: rand() < 0.5, backgroundTasks: rand() < 0.1 ? 1 : 0, runningAgents: rand() < 0.1 ? 1 : 0,
    })
  }
  if (kind < 0.95) {
    const id = choose(rand, ids)
    const by = choose(rand, ['qa', 'architect'] as const)
    const verdict = by === 'qa' ? choose(rand, ['pass', 'fail', 'blocked'] as const) : choose(rand, ['pass', 'fail'] as const)
    return { kind: 'review', taskId: id, end: rand() < 0.8 ? (state.ends[id] ?? 0) : 9, by, verdict, ...(rand() < 0.5 ? { note: 'a note' } : {}) } as FlowEvent
  }
  return { kind: 'humanPrompt' }
}

test('property: with an escalation the second decision is never less strict than the first', () => {
  const rand = prng(18)
  const doneIds = (s: FlowState) => Object.keys(s.status).filter(id => s.status[id] === 'done')
  const activeIds = (s: FlowState) => Object.keys(s.status).filter(id => s.status[id] === 'active')
  let cases = 0
  let changed = 0
  let retried = 0
  let tightened = 0
  for (let round = 0; round < 6000; round++) {
    const built = randomFlow(rand)
    if (!built) continue
    const { flow, hash } = built
    const state = randomState(rand, flow, hash)
    const event = randomEvent(rand, flow, state)
    const available = { qa: rand() < 0.8, architect: rand() < 0.8 }
    const base: DecideOptions = { available }
    const first = decide(deepFreeze(clone(flow)), deepFreeze(clone(state)), deepFreeze(clone(event)), undefined, deepFreeze(clone(base)))
    for (const escalation of [{ requireQa: true }, { retryToArchitect: true }, { requireQa: true, retryToArchitect: true }] as const) {
      cases++
      const second = decide(deepFreeze(clone(flow)), deepFreeze(clone(state)), deepFreeze(clone(event)), undefined, deepFreeze({ ...base, ...escalation }))
      // Never more tasks done.
      for (const id of doneIds(second.state)) {
        // A task the ledger already holds done is done in both passes.
        expect(doneIds(first.state), `${id} done only after the escalation`).toContain(id)
      }
      // Never fewer attempts.
      for (const id of Object.keys(first.state.attempts)) {
        expect(second.state.attempts[id] ?? 0, `attempts of ${id}`).toBeGreaterThanOrEqual(first.state.attempts[id] ?? 0)
      }
      // Never a block or a pause turned into an allow or an advance.
      if (first.action === 'block' || first.action === 'pause') {
        expect(['block', 'pause'], `${first.condition} became ${second.action}/${second.condition}`).toContain(second.action)
      }
      // Never an advance the first pass did not make, and never a decision that completes the flow.
      if (second.action === 'advance') expect(first.action).toBe('advance')
      if (second.action === 'complete') expect(first.action).toBe('complete')
      // The same task: the event's own, or the one the first pass named.
      if (event.kind === 'taskEnd' || event.kind === 'review') {
        if (second.task !== undefined) expect([first.task, event.taskId], 'target task').toContain(second.task)
        // It starts no task the first pass did not (the event's own task may stay active instead of moving on).
        for (const id of activeIds(second.state)) {
          if (!activeIds(first.state).includes(id)) expect(id).toBe(event.taskId)
        }
      }
      // Nothing is paused, stopped or finished by the judge.
      if (!first.state.paused) expect(second.state.paused).toBe(false)
      if (!first.state.done) expect(second.state.done).toBe(false)
      expect(second.state.stopped).toBe(first.state.stopped)
      // Escalations are cumulative only in what they require: an escalation that changes nothing changes nothing at all.
      const identical = JSON.stringify(second) === JSON.stringify(first)
      if (!identical) changed++
      if (second.condition === 'architect' && first.condition === 'retry') retried++
      if (second.state.qaRequired.length > first.state.qaRequired.length) tightened++
    }
  }
  // The generator reaches every kind of escalation, so the properties above were exercised and not vacuous.
  expect(cases).toBeGreaterThan(9000)
  expect(changed).toBeGreaterThan(300)
  expect(retried).toBeGreaterThan(50)
  expect(tightened).toBeGreaterThan(50)
})

test('property: an escalation that fires in a second pass is the first pass plus a requirement, never a patch on its output', () => {
  const rand = prng(1810)
  let escalated = 0
  for (let round = 0; round < 3000; round++) {
    const built = randomFlow(rand)
    if (!built) continue
    const { flow, hash } = built
    const state = randomState(rand, flow, hash)
    const event = randomEvent(rand, flow, state)
    const available = { qa: true, architect: true }
    const first = decide(flow, state, event, undefined, { available })
    // Passing the same options again, with the escalation off, is the first pass exactly: the pass is a function of its inputs.
    expect(decide(flow, state, event, undefined, { available, requireQa: false, retryToArchitect: false })).toEqual(first)
    const second = decide(flow, state, event, undefined, { available, requireQa: true, retryToArchitect: true })
    if (JSON.stringify(second) !== JSON.stringify(first)) escalated++
  }
  expect(escalated).toBeGreaterThan(100)
})

// --- a Stop whose failing task has its architect diagnosis open ---

test('a held Stop whose task has its diagnosis open names the architect, the [id] description, resume and stop', () => {
  const { flow, hash } = chain()
  const decision = decide(flow, approved(flow, hash, { attempts: { A: 3 } }), stopEvent({ A: [fail('A', 'boom')] }), undefined, { diagnosis: ['A'], available: ALL })
  expect(decision).toMatchObject({ action: 'block', condition: 'check_failed', task: 'A' })
  expect(decision.reason).toContain('ask the architect to diagnose it')
  expect(decision.reason).toContain('[A]')
  expect(decision.reason).toContain('/pantheon flow resume')
  expect(decision.reason).toContain('/pantheon flow stop')
  expect(decision.reason).toContain('boom')
  // The attempts are spent, so "fix the failure, then try to stop again" would contradict the diagnosis: it is left out.
  expect(decision.reason).not.toContain('Fix the failure, then try to stop again')
})

test('a held Stop for a task not in the diagnosis list keeps the plain check_failed text, byte for byte', () => {
  const { flow, hash } = chain()
  const plain = decide(flow, approved(flow, hash), stopEvent({ A: [fail('A', 'boom')] }))
  const others = decide(flow, approved(flow, hash), stopEvent({ A: [fail('A', 'boom')] }), undefined, { diagnosis: ['B'], available: ALL })
  expect(plain.reason).toBe('Task A (goal A) is not done: its checks fail. Fix the failure, then try to stop again.\n\n$ run A\nboom')
  expect(others.reason).toBe(plain.reason)
  expect(others.reason).not.toContain('architect')
  expect(others.reason).not.toContain('/pantheon flow')
})

test('with the architect disabled, a held Stop whose diagnosis is open gives the role_unavailable text', () => {
  const { flow, hash } = chain()
  const gone = decide(flow, approved(flow, hash, { attempts: { A: 3 } }), stopEvent({ A: [fail('A', 'boom')] }), undefined, { diagnosis: ['A'], available: { qa: true, architect: false } })
  expect(gone).toMatchObject({ action: 'pause', condition: 'role_unavailable', task: 'A' })
  expect(gone.reason).toContain("the architect is disabled; enable it in pantheon.json and /pantheon flow resume, or /pantheon flow stop.")
  expect(gone.reason).not.toContain('ask the architect')
  expect(gone.state.paused).toBe(true)
})
