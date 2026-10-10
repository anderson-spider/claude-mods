// The flow policy: one pure reducer from an event to a decision. No host access, no I/O, no clock.
// Deterministic checks decide; a judgment is accepted only so the caller can record it and never
// changes the action. The input state is never mutated: the next state comes back in `decision.state`.

import { branchOnly, eligible, findTask, flowHash, requiredTasks } from './plan'
import type { Flow, FlowTask } from './plan'
import type { Action, CheckResult, Decision, FlowEvent, FlowState, Judgment, Mode } from './types'

/** Failing output quoted in a reason. */
export const OUTPUT_TAIL = 1200
/** The engine honors 8 consecutive Stop blocks; the policy stops one short of it. */
export const CONSECUTIVE_CAP = 7
/** The same failure (task and output) this many times in a row pauses and asks the person. */
export const LOOP_LIMIT = 3

/** What a decision was before shadow or off mode turned it into `allow`; the journal reads it. */
export type WouldBe = { action: Action; condition: string; reason: string; task?: string }
export type ModeDecision = Decision & { wouldBe?: WouldBe }

export function newState(flow: Flow, hash: string): FlowState {
  const status: FlowState['status'] = Object.fromEntries(flow.tasks.map(task => [task.id, 'pending' as const]))
  const first = eligible(flow, status)[0]
  if (first) status[first] = 'active'
  return {
    planId: flow.planId, hash, status, attempts: {}, reviewed: [], awaitingReview: [], sideEffectsDone: [],
    blocks: 0, consecutiveBlocks: 0, paused: false, stopped: false, done: false,
  }
}

/**
 * The state for an edited plan: progress of the tasks still in the flow is kept, removed tasks are dropped,
 * new ones are pending, and the approval is cleared so the person approves the new hash again.
 */
export function rebase(flow: Flow, state: FlowState): FlowState {
  const ids = new Set(flow.tasks.map(task => task.id))
  const keep = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)))
  const s: FlowState = {
    ...state,
    planId: flow.planId,
    hash: flowHash(flow),
    status: keep(state.status),
    attempts: keep(state.attempts),
    reviewed: state.reviewed.filter(id => ids.has(id)),
    awaitingReview: (state.awaitingReview ?? []).filter(id => ids.has(id)),
    sideEffectsDone: [...state.sideEffectsDone],
    ...(state.lastFailure ? { lastFailure: { ...state.lastFailure } } : {}),
  }
  delete s.approvedHash
  s.done = false
  for (const task of flow.tasks) if (!(task.id in s.status)) s.status[task.id] = 'pending'
  // A task that became risky after it was done has no review receipt: it goes back, unless its side effect already ran.
  for (const task of flow.tasks) {
    if (s.status[task.id] === 'done' && task.risk && !s.reviewed.includes(task.id) && !s.sideEffectsDone.includes(task.id)) s.status[task.id] = 'pending'
  }
  for (const id of s.sideEffectsDone) if (ids.has(id)) s.status[id] = 'done'
  keepOrActivate(flow, s)
  return s
}

/** Records the effective mode; the budget starts clean only on the switch into enforce, never on a reload. */
export function withMode(state: FlowState, mode: Mode): FlowState {
  if (mode === 'enforce' && state.mode !== 'enforce') return { ...enterEnforce(state), mode }
  return { ...state, mode }
}

/** The budget and failure bookkeeping starts clean when the flow goes from shadow into enforce. */
export function enterEnforce(state: FlowState): FlowState {
  const s: FlowState = { ...state, attempts: {}, blocks: 0, consecutiveBlocks: 0 }
  delete s.lastFailure
  return s
}

/** The judgment is accepted and ignored: it is journaled by the caller, never acted on. */
export function decide(flow: Flow, state: FlowState, event: FlowEvent, _judgment?: Judgment): Decision {
  switch (event.kind) {
    case 'stop': return onStop(flow, begin(flow, state), event, state)
    case 'taskEnd': return onTaskEnd(flow, begin(flow, state), event, state)
    case 'humanPrompt': {
      const s = begin(flow, state)
      s.blocks = 0
      s.consecutiveBlocks = 0
      return make(s, 'allow', 'refill', 'The person wrote: the block budget is refilled.')
    }
    case 'review': return onReview(flow, begin(flow, state), event, state)
  }
}

/**
 * enforce: unchanged. shadow: nothing blocks or moves the host, so block, advance, failTask and pause
 * become `allow` with an empty reason and the original in `wouldBe`; no budget is charged and nothing is
 * paused. Progress that reflects real work (task_done, all_done) stays in `state`; a decision that would
 * only have sent work back (regression, on_fail, looping, any block, failTask or pause) keeps `attempts`
 * and `lastFailure` but restores status, awaitingReview and reviewed. off: `allow` with `previous` untouched.
 */
export function applyMode(decision: Decision, mode: Mode, previous: FlowState): ModeDecision {
  if (mode === 'enforce') return decision
  const wouldBe: WouldBe = { action: decision.action, condition: decision.condition, reason: decision.reason, ...(decision.task ? { task: decision.task } : {}) }
  if (mode === 'off') return { action: 'allow', condition: 'off', reason: '', state: previous, wouldBe }
  // The host must not surface anything in shadow: every reason moves into `wouldBe`.
  if (!['block', 'advance', 'failTask', 'pause'].includes(decision.action)) return { ...decision, reason: '', wouldBe }
  const progress = decision.action === 'advance' && decision.condition !== 'on_fail'
  const state: FlowState = {
    ...decision.state,
    blocks: previous.blocks,
    consecutiveBlocks: previous.consecutiveBlocks,
    paused: previous.paused,
    lastInstruction: previous.lastInstruction,
    ...(progress ? {} : {
      status: { ...previous.status },
      reviewed: [...previous.reviewed],
      awaitingReview: [...(previous.awaitingReview ?? [])],
    }),
  }
  if (state.lastInstruction === undefined) delete state.lastInstruction
  return { action: 'allow', condition: decision.condition, reason: '', state, wouldBe, ...(decision.task ? { task: decision.task } : {}) }
}

/** Whether the flow on disk is the one the person approved. */
function approvedFor(flow: Flow, state: FlowState): boolean {
  const hash = flowHash(flow)
  return state.approvedHash === hash && state.hash === hash
}

// --- stop ---

function onStop(flow: Flow, s: FlowState, event: Extract<FlowEvent, { kind: 'stop' }>, original: FlowState): Decision {
  // 1. nothing to enforce; an unapproved or edited flow is left exactly as it is
  if (!approvedFor(flow, original)) return make(copyState(original), 'allow', 'unapproved', 'The flow is not approved, or the plan changed since it was, so nothing is enforced.')
  // A Stop that does not follow one of our blocks starts the consecutive run over.
  if (!event.stopHookActive) s.consecutiveBlocks = 0
  const allow = (condition: string, reason: string) => { s.consecutiveBlocks = 0; return make(s, 'allow', condition, reason) }
  if (s.done) return allow('already_done', 'The flow is already complete.')
  if (s.paused) return allow('paused', 'The flow is paused until the person resumes it.')
  if (s.stopped) return allow('stopped', 'The flow was stopped by the person.')

  // 2. background work: the turn may end, no budget is spent
  if (event.backgroundTasks > 0 || event.runningAgents > 0) {
    s.consecutiveBlocks = 0
    return make(s, 'wait', 'waiting', `Waiting for ${event.backgroundTasks} background task(s) and ${event.runningAgents} running agent(s); their results will wake the session.`)
  }

  const branches = branchOnly(flow.tasks)
  const required = requiredTasks(flow)
  // Done tasks whose checks now fail, and required done tasks with a declared check that has no passing result.
  const regressedIds = () => flow.tasks.filter(task => s.status[task.id] === 'done' && !branches.has(task.id) && (event.checks[task.id] ?? []).some(check => check.passed === false)).map(task => task.id)
  const unverifiedIds = () => required.filter(id => s.status[id] === 'done' && !checksPassed(findTask(flow, id)!, event.checks[id]))

  // 3. budget: settle by checks, then let the turn end
  const overBlocks = s.blocks >= flow.limits.maxBlocks
  const overRun = event.stopHookActive && original.consecutiveBlocks >= CONSECUTIVE_CAP
  if (overBlocks || overRun) {
    const settled = settleByChecks(flow, s, event.checks)
    const open = required.filter(id => s.status[id] !== 'done')
    const regressed = regressedIds()
    const unverified = unverifiedIds()
    const head = overBlocks
      ? `Stopping: the flow already kept the session going ${s.blocks} times (maxBlocks ${flow.limits.maxBlocks}).`
      : 'Stopping: the engine limit of consecutive Stop blocks is near.'
    if (open.length === 0 && regressed.length === 0 && unverified.length === 0) {
      s.done = true
      s.lastFailure = undefined
      return allow('complete', `${head} Checks pass for every task: the flow is complete.`)
    }
    keepOrActivate(flow, s)
    const parts = [head]
    if (settled.length) parts.push(`Checks pass for ${settled.join(', ')}: marked done.`)
    if (open.length) parts.push(`Still open: ${open.join(', ')}.`)
    if (regressed.length) parts.push(`Regressed (done, but their checks now fail): ${regressed.join(', ')}.`)
    if (unverified.length) parts.push(`Not verified (a check has no passing result): ${unverified.join(', ')}.`)
    parts.push('Send any message to resume with a fresh budget.')
    return allow('budget', parts.join(' '))
  }

  // 4. regression: a done task whose checks now fail
  for (const task of flow.tasks) {
    if (!regressedIds().includes(task.id)) continue
    const output = tail(describe((event.checks[task.id] ?? []).filter(check => check.passed === false)))
    if (task.sideEffect) {
      s.paused = true
      s.consecutiveBlocks = 0
      return instruct(s, 'pause', 'side_effect_regression',
        `Task ${task.id} (${task.goal}) has a side effect that already ran, but its checks now fail. The flow will not re-run it: ask the person whether to redo it by hand.\n\n${output}`, task.id)
    }
    // What was started on top of the broken task waits until it is fixed.
    for (const id of downstream(flow, task.id)) {
      if (s.status[id] === 'active') s.status[id] = 'pending'
      s.awaitingReview = s.awaitingReview.filter(other => other !== id)
    }
    s.status[task.id] = 'active'
    delete s.attempts[task.id]
    s.reviewed = s.reviewed.filter(id => id !== task.id)
    s.awaitingReview = s.awaitingReview.filter(id => id !== task.id)
    s.lastFailure = undefined
    charge(s)
    return instruct(s, 'block', 'regression',
      `Regression: task ${task.id} (${task.goal}) was done but its checks now fail. Re-delegate it with the description prefix [${task.id}] and fix it before continuing.\n\n${output}`, task.id)
  }

  const actives = flow.tasks.filter(task => s.status[task.id] === 'active')

  // 5. an active task has a failing check
  for (const active of actives) {
    const failed = (event.checks[active.id] ?? []).filter(check => check.passed !== true)
    if (failed.length === 0) continue
    const output = tail(describe(failed))
    const key = `${active.id}\n${output}`
    const count = s.lastFailure?.key === key ? s.lastFailure.count + 1 : 1
    s.lastFailure = { key, count }
    // Its checks no longer back a pending review: it needs a fresh task end.
    s.awaitingReview = s.awaitingReview.filter(id => id !== active.id)
    if (count >= LOOP_LIMIT) {
      s.paused = true
      s.consecutiveBlocks = 0
      return instruct(s, 'pause', 'looping',
        `Task ${active.id} (${active.goal}) failed ${count} times in a row with the same output. Stop retrying: ask the person how to proceed.\n\n${output}`, active.id)
    }
    charge(s)
    return instruct(s, 'block', 'check_failed',
      `Task ${active.id} (${active.goal}) is not done: its checks fail. Fix the failure, then try to stop again.\n\n${output}`, active.id)
  }
  s.lastFailure = undefined

  // 6. a risky task whose checks passed waits for the oracle's verdict
  const waiting = flow.tasks.find(task => s.awaitingReview.includes(task.id) && s.status[task.id] !== 'done')
  if (waiting) {
    charge(s)
    return instruct(s, 'block', 'review_needed', `Task ${waiting.id} is risky and its checks pass, but it has no oracle review yet. Ask the oracle to review it before stopping.`, waiting.id)
  }

  // 7. everything required is done and every declared check of it passes
  if (required.every(id => s.status[id] === 'done')) {
    const unverified = unverifiedIds()
    if (unverified.length) {
      s.consecutiveBlocks = 0
      return make(s, 'allow', 'unverified', `Every required task is done, but a check has no passing result for: ${unverified.join(', ')}. The flow is not marked complete.`)
    }
    s.done = true
    s.consecutiveBlocks = 0
    return make(s, 'complete', 'complete', 'Every required task is done and its checks pass: the flow is complete.')
  }

  // 8. keep going; with nothing marked active, the first eligible task is the one to work on
  keepOrActivate(flow, s)
  const working = flow.tasks.filter(task => s.status[task.id] === 'active')
  charge(s)
  return instruct(s, 'block', 'continue', continueReason(flow, s, working), working[0]?.id)
}

function continueReason(flow: Flow, s: FlowState, actives: FlowTask[]): string {
  if (actives.length === 0) return `Required tasks are still open (${requiredTasks(flow).filter(id => s.status[id] !== 'done').join(', ')}) but none is active. Pick the next one and work on it.`
  const lines: string[] = []
  for (const active of actives) {
    lines.push(`Task ${active.id} is not finished: ${active.goal}.`)
    for (const criterion of active.acceptance.criteria) lines.push(`- criterion: ${criterion}`)
    for (const check of active.acceptance.checks) lines.push(`- check: ${check.argv.join(' ')}`)
  }
  lines.push('Finish it before stopping.')
  return lines.join('\n')
}

/** Marks done, in dependency order, every eligible task with checks that all passed; side effects and unreviewed risk tasks are never settled. */
function settleByChecks(flow: Flow, s: FlowState, checks: Record<string, CheckResult[]>): string[] {
  const settled: string[] = []
  for (;;) {
    const next = eligible(flow, s.status)
      .map(id => findTask(flow, id)!)
      .find(task => !task.sideEffect && (!task.risk || s.reviewed.includes(task.id)) && task.acceptance.checks.length > 0 && checksPassed(task, checks[task.id]))
    if (!next) return settled
    s.status[next.id] = 'done'
    s.awaitingReview = s.awaitingReview.filter(id => id !== next.id)
    delete s.attempts[next.id]
    settled.push(next.id)
  }
}

// --- task end and review ---

function onTaskEnd(flow: Flow, s: FlowState, event: Extract<FlowEvent, { kind: 'taskEnd' }>, original: FlowState): Decision {
  const idle = idleDecision(flow, original)
  if (idle) return idle
  const task = findTask(flow, event.taskId)
  // Parallel tasks: the ones being worked on, and any eligible one that finishes ahead of its turn.
  if (!task || s.status[task.id] === 'done' || !(s.status[task.id] === 'active' || eligible(flow, s.status).includes(task.id))) {
    return make(s, 'allow', 'not_active', `Task ${event.taskId} is not an active or eligible task, so its result is not acted on.`)
  }
  const failures = failingChecks(task, event.checks)
  if (event.ownershipDenials > 0 || failures.length) return failAttempt(flow, s, task, tail(describe(failures)), event.ownershipDenials)

  if (task.risk && !s.reviewed.includes(task.id)) {
    if (!s.awaitingReview.includes(task.id)) s.awaitingReview.push(task.id)
    return make(s, 'allow', 'review_needed', `Task ${task.id} passes its checks but is risky: ask the oracle to review it before it counts as done.`, task.id)
  }
  return finishTask(flow, s, task)
}

/** Task ends and reviews do nothing on a flow that is unapproved, edited, done, paused or stopped. */
function idleDecision(flow: Flow, original: FlowState): Decision | undefined {
  if (!approvedFor(flow, original)) return make(copyState(original), 'allow', 'unapproved', 'The flow is not approved, or the plan changed since it was, so nothing is enforced.')
  if (original.done) return make(copyState(original), 'allow', 'already_done', 'The flow is already complete.')
  if (original.paused) return make(copyState(original), 'allow', 'paused', 'The flow is paused until the person resumes it.')
  if (original.stopped) return make(copyState(original), 'allow', 'stopped', 'The flow was stopped by the person.')
  return undefined
}

function onReview(flow: Flow, s: FlowState, event: Extract<FlowEvent, { kind: 'review' }>, original: FlowState): Decision {
  const idle = idleDecision(flow, original)
  if (idle) return idle
  const task = findTask(flow, event.taskId)
  if (!task || !s.awaitingReview.includes(task.id)) {
    return make(s, 'allow', 'review_ignored', `Review for ${event.taskId} ignored: the task is not awaiting review.`)
  }
  if (event.verdict === 'approved') {
    if (!s.reviewed.includes(task.id)) s.reviewed.push(task.id)
    return finishTask(flow, s, task)
  }
  const note = event.note?.trim()
  return failAttempt(flow, s, task, note ? tail(`The oracle rejected the review: ${note}`) : 'The oracle rejected the review.', 0)
}

/** A failed attempt: retry the implementer, then the oracle (or the onFail task), then the person. */
function failAttempt(flow: Flow, s: FlowState, task: FlowTask, output: string, ownershipDenials: number): Decision {
  const max = task.loop?.maxIterations ?? flow.limits.maxAttempts
  const attempts = (s.attempts[task.id] ?? 0) + 1
  s.attempts[task.id] = attempts
  // Whatever receipt it had no longer covers the work.
  s.reviewed = s.reviewed.filter(id => id !== task.id)
  s.awaitingReview = s.awaitingReview.filter(id => id !== task.id)
  const withOutput = (text: string) => (output ? `${text}\n\n${output}` : text)
  if (attempts > max) {
    s.paused = true
    return instruct(s, 'pause', 'ask_person',
      withOutput(`Task ${task.id} (${task.goal}) failed ${attempts} times, past the limit of ${max}. Ask the person how to proceed.`), task.id)
  }
  if (ownershipDenials > 0) {
    return instruct(s, 'failTask', 'ownership',
      `Task ${task.id} tried to write ${ownershipDenials} file(s) outside its files. Retry the same implementer and keep to: ${task.files.join(', ')}.`, task.id)
  }
  if (attempts < max) {
    return instruct(s, 'failTask', 'retry', withOutput(`Task ${task.id} (${task.goal}) failed attempt ${attempts} of ${max}. Retry the same implementer with this output.`), task.id)
  }
  const branch = task.onFail ? findTask(flow, task.onFail) : undefined
  if (branch && s.status[branch.id] !== 'done') {
    s.status[task.id] = 'failed'
    s.status[branch.id] = 'active'
    return instruct(s, 'advance', 'on_fail', withOutput(`Task ${task.id} failed ${attempts} times. Move to ${branch.id} (${branch.goal}).`), branch.id)
  }
  return instruct(s, 'failTask', 'oracle', withOutput(`Task ${task.id} (${task.goal}) failed ${attempts} times. Ask the oracle to diagnose it before another attempt.`), task.id)
}

/**
 * The task's work is verified: mark it done and move on. Finishing the last required task never completes the
 * flow here; the next Stop sees every done task's checks and completes it (all_done tells the agent to stop).
 */
function finishTask(flow: Flow, s: FlowState, task: FlowTask): Decision {
  const wasActive = s.status[task.id] === 'active'
  s.status[task.id] = 'done'
  s.awaitingReview = s.awaitingReview.filter(id => id !== task.id)
  if (task.sideEffect && !s.sideEffectsDone.includes(task.id)) s.sideEffectsDone.push(task.id)
  delete s.attempts[task.id]
  s.lastFailure = undefined
  if (requiredTasks(flow).every(id => s.status[id] === 'done')) {
    return instruct(s, 'advance', 'all_done', `Task ${task.id} is done and every required task is done. Stop to verify: the flow completes when the checks of all tasks pass.`)
  }
  const stillActive = flow.tasks.find(other => s.status[other.id] === 'active')
  let next: string | undefined
  // An eligible task finishing ahead of its turn leaves the current work alone.
  if (wasActive || !stillActive) {
    next = eligible(flow, s.status).find(id => s.status[id] !== 'active')
    if (next) s.status[next] = 'active'
  }
  const target = next ?? stillActive?.id
  if (!target) {
    s.paused = true
    return instruct(s, 'pause', 'no_eligible', `Task ${task.id} is done but no remaining task is eligible. Ask the person to check dependsOn in the plan.`, task.id)
  }
  const goal = findTask(flow, target)!.goal
  return instruct(s, 'advance', 'task_done', `Task ${task.id} is done. ${next ? 'Next' : 'Still active'}: ${target} (${goal}).`, target)
}

// --- helpers ---

/** A working copy; a side-effect task recorded in the ledger counts as done even if the status was lost. */
function begin(flow: Flow, state: FlowState): FlowState {
  const s: FlowState = {
    ...state,
    status: { ...state.status },
    attempts: { ...state.attempts },
    reviewed: [...state.reviewed],
    awaitingReview: [...(state.awaitingReview ?? [])],
    sideEffectsDone: [...state.sideEffectsDone],
    ...(state.lastFailure ? { lastFailure: { ...state.lastFailure } } : {}),
  }
  for (const id of s.sideEffectsDone) if (findTask(flow, id)) s.status[id] = 'done'
  return s
}

function make(s: FlowState, action: Action, condition: string, reason: string, task?: string): Decision {
  return { action, condition, reason, state: s, ...(task ? { task } : {}) }
}

/** block, advance, failTask and pause are instructions: the last one is re-injected on the next human prompt. */
function instruct(s: FlowState, action: Action, condition: string, reason: string, task?: string): Decision {
  s.lastInstruction = reason
  return make(s, action, condition, reason, task)
}

function charge(s: FlowState): void {
  s.blocks += 1
  s.consecutiveBlocks += 1
}

/** A copy with the same content, for decisions that leave the state as it was. */
function copyState(state: FlowState): FlowState {
  return {
    ...state,
    status: { ...state.status },
    attempts: { ...state.attempts },
    reviewed: [...state.reviewed],
    awaitingReview: [...(state.awaitingReview ?? [])],
    sideEffectsDone: [...state.sideEffectsDone],
    ...(state.lastFailure ? { lastFailure: { ...state.lastFailure } } : {}),
  }
}

/** Every task that depends on `id`, directly or through others. */
function downstream(flow: Flow, id: string): string[] {
  const found = new Set<string>()
  const queue = [id]
  while (queue.length) {
    const current = queue.pop()!
    for (const task of flow.tasks) {
      if (task.dependsOn.includes(current) && !found.has(task.id)) { found.add(task.id); queue.push(task.id) }
    }
  }
  return [...found]
}

function keepOrActivate(flow: Flow, s: FlowState): void {
  if (flow.tasks.some(task => s.status[task.id] === 'active')) return
  const first = eligible(flow, s.status)[0]
  if (first) s.status[first] = 'active'
}

function checksPassed(task: FlowTask, results: CheckResult[] | undefined): boolean {
  const ran = results ?? []
  return ran.length >= task.acceptance.checks.length && ran.every(check => check.passed === true)
}

/** The results that count against a task: failed or unable to run, or missing altogether. */
function failingChecks(task: FlowTask, checks: CheckResult[]): CheckResult[] {
  const bad = checks.filter(check => check.passed !== true)
  if (bad.length === 0 && checks.length < task.acceptance.checks.length) {
    return task.acceptance.checks.slice(checks.length).map(check => ({ argv: check.argv, passed: null, output: 'no result reported for this check' }))
  }
  return bad
}

function describe(checks: CheckResult[]): string {
  return checks.map(check => `$ ${check.argv.join(' ')}${check.passed === null ? ' (could not run)' : ''}\n${check.output.trim()}`.trim()).join('\n\n')
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL ? text : `...${text.slice(-(OUTPUT_TAIL - 3))}`
}
