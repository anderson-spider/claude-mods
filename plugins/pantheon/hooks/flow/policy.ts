// The flow policy: one pure reducer from an event to a decision. No host access, no I/O, no clock.
// Deterministic checks decide; a judgment is accepted only so the caller can record it and never
// changes the action. The input state is never mutated: the next state comes back in `decision.state`.
//
// Receipts: a task is done only when its checks pass AND every receipt it requires exists (`requiredReceipts`: the
// architect's review for a `risk` task, QA's verdict for a task with acceptance criteria, and QA for any non-side-effect
// task when the caller passes `requireQa`). Every path that finishes a task goes through `missingReceipts`, so no path
// can settle a task that is missing one.

import { branchOnly, eligible, findTask, flowHash, requiredTasks } from './plan'
import type { Flow, FlowTask } from './plan'
import { SEEN_IDS_MAX, remember } from './types'
import type { Action, CheckResult, DecideOptions, Decision, FlowEvent, FlowState, Judgment, Mode, Receipts, Reviewer } from './types'

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
    planId: flow.planId, hash, status, attempts: {}, awaiting: [], receipts: {}, qaRequired: [], ends: {}, sideEffectsDone: [],
    blocks: 0, consecutiveBlocks: 0, paused: false, stopped: false, done: false, seenIds: flow.tasks.map(task => task.id),
  }
}

/**
 * The state for a changed effective flow: progress of the tasks still in the flow is kept, removed tasks are dropped (and
 * retired, so no later amendment reuses their ids), new ones are pending. Enforcement is not dropped: `approvedHash` stays,
 * and `adoptedHash` records the new flow's hash whenever it is not the one the person approved.
 *
 * This function never decides whether `flow` is authorized to be the effective one. The controller passes only the
 * approved snapshot, an amendment `amend` allowed, or a plan the person just approved (which `approve` then records);
 * for a plan nobody approved it clears the approval first (`unapprove`), so a rebase can never approve it.
 */
export function rebase(flow: Flow, state: FlowState): FlowState {
  const ids = new Set(flow.tasks.map(task => task.id))
  const keep = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)))
  const hash = flowHash(flow)
  const s: FlowState = {
    ...state,
    planId: flow.planId,
    hash,
    status: keep(state.status),
    attempts: keep(state.attempts),
    awaiting: state.awaiting.filter(a => ids.has(a.task)).map(a => ({ ...a })),
    receipts: copyReceipts(keep(state.receipts)),
    qaRequired: state.qaRequired.filter(id => ids.has(id)),
    ends: keep(state.ends),
    sideEffectsDone: [...state.sideEffectsDone],
    ...(state.lastFailure ? { lastFailure: { ...state.lastFailure } } : {}),
  }
  if (state.lastOutput) {
    const kept = keep(state.lastOutput)
    if (Object.keys(kept).length > 0) s.lastOutput = kept
    else delete s.lastOutput
  }
  // Every id the plan has had is remembered, so no later amendment reuses one the flow dropped.
  s.seenIds = remember(state.seenIds, [...Object.keys(state.status), ...flow.tasks.map(task => task.id)], SEEN_IDS_MAX)
  // The edits that waited were about the flow before this one.
  delete s.seenEdits
  if (state.approvedHash !== undefined && state.approvedHash !== hash) s.adoptedHash = hash
  else delete s.adoptedHash
  s.done = false
  for (const task of flow.tasks) if (!(task.id in s.status)) s.status[task.id] = 'pending'
  // A receipt nobody requires any more (the task is no longer risky, say) is not waited for.
  s.awaiting = s.awaiting.filter(a => requiredReceipts(findTask(flow, a.task)!, {}, s.qaRequired).includes(a.by))
  // A task that now requires a receipt it never earned (it became risky, or got criteria, after it was done) goes back,
  // unless its side effect already ran.
  for (const task of flow.tasks) {
    if (s.status[task.id] === 'done' && missingReceipts(task, s).length > 0 && !s.sideEffectsDone.includes(task.id)) s.status[task.id] = 'pending'
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

/** The budget, failure bookkeeping and unfinished tasks' receipts start clean when the flow goes from shadow into enforce. */
export function enterEnforce(state: FlowState): FlowState {
  const s: FlowState = { ...state, attempts: {}, blocks: 0, consecutiveBlocks: 0 }
  delete s.lastFailure
  // The attempts start over, and so does what the retry battery compares them with.
  delete s.lastOutput
  // What shadow let wait for a receipt, or earn one, no agent was ever held to: unfinished tasks start enforcement clean.
  s.awaiting = state.awaiting.filter(a => state.status[a.task] === 'done').map(a => ({ ...a }))
  s.receipts = copyReceipts(Object.fromEntries(Object.entries(state.receipts).filter(([id]) => state.status[id] === 'done')))
  return s
}

/**
 * The judgment is accepted and ignored: it is journaled by the caller, never acted on. `opts` is how the judge speaks: the
 * caller runs `decide` once without escalations, asks the judge only where the result depends on it, and runs `decide` again
 * with `requireQa` or `retryToArchitect`. An escalation can only make the decision stricter: it never marks more tasks done,
 * never lowers an attempt count, never turns a block or a pause into an allow or an advance, and never starts a task the
 * first pass did not (it is an input to a second decision, never a patch on the first).
 */
export function decide(flow: Flow, state: FlowState, event: FlowEvent, _judgment: Judgment | undefined, opts: StopOptions): Decision {
  switch (event.kind) {
    case 'stop': return onStop(flow, begin(flow, state), event, state, opts)
    case 'taskEnd': return onTaskEnd(flow, begin(flow, state), event, state, opts)
    case 'humanPrompt': {
      const s = begin(flow, state)
      s.blocks = 0
      s.consecutiveBlocks = 0
      return make(s, 'allow', 'refill', 'The person wrote: the block budget is refilled.')
    }
    case 'review': return onReview(flow, begin(flow, state), event, state, opts)
  }
}

/**
 * enforce: unchanged. shadow: nothing blocks or moves the host, so block, advance, failTask and pause
 * become `allow` with an empty reason and the original in `wouldBe`; no budget is charged and nothing is
 * paused. Progress that reflects real work (task_done, all_done) stays in `state`; a decision that would
 * only have sent work back (regression, on_fail, looping, any block, failTask or pause) keeps `attempts`
 * and `lastFailure` but restores status, awaiting and receipts. off: `allow` with `previous` untouched.
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
      awaiting: previous.awaiting.map(a => ({ ...a })),
      receipts: copyReceipts(previous.receipts),
      qaRequired: [...previous.qaRequired],
    }),
  }
  if (state.lastInstruction === undefined) delete state.lastInstruction
  return { action: 'allow', condition: decision.condition, reason: '', state, wouldBe, ...(decision.task ? { task: decision.task } : {}) }
}

/** Whether `flow` is the one in force: the person's approval, or what was adopted over it, and the state's progress is for it. */
function approvedFor(flow: Flow, state: FlowState): boolean {
  const hash = flowHash(flow)
  return state.approvedHash !== undefined && (state.adoptedHash ?? state.approvedHash) === hash && state.hash === hash
}

// --- stop ---

/**
 * What a Stop may be told beyond `DecideOptions`: the ids of active tasks whose architect diagnosis is open (the controller's
 * `diagnosisOpen`, computed for the Stop only). A held Stop for such a task says what to do next; nothing else changes.
 */
export type StopOptions = DecideOptions & { diagnosis?: readonly string[] }

function onStop(flow: Flow, s: FlowState, event: Extract<FlowEvent, { kind: 'stop' }>, original: FlowState, opts: StopOptions): Decision {
  // 1. nothing to enforce; a flow nobody approved, or a state that is not for this flow, is left exactly as it is
  if (!approvedFor(flow, original)) return make(copyState(original), 'allow', 'unapproved', 'The flow is not approved, or its approval does not match the plan in force, so nothing is enforced.')
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
    const settled = settleByChecks(flow, s, event.checks, opts)
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
    const waitingOn = s.awaiting.filter(a => s.status[a.task] !== 'done')
    if (waitingOn.length) parts.push(`Awaiting receipts: ${waitingOn.map(a => `${a.task} (${a.by})`).join(', ')}.`)
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
      if (s.status[id] !== 'done') clearReceipts(s, id)
    }
    s.status[task.id] = 'active'
    delete s.attempts[task.id]
    // The receipts covered the work as it was: the task needs them again.
    clearReceipts(s, task.id)
    s.lastFailure = undefined
    charge(s)
    return instruct(s, 'block', 'regression',
      `Regression: task ${task.id} (${task.goal}) was done but its checks now fail. Re-delegate it with the description prefix [${task.id}] and fix it before continuing.\n\n${output}`, task.id)
  }

  const actives = flow.tasks.filter(task => s.status[task.id] === 'active')

  // 5. an active task, or one waiting for a receipt, has a failing check
  const checked = flow.tasks.filter(task => s.status[task.id] === 'active' || (s.status[task.id] !== 'done' && s.awaiting.some(a => a.task === task.id)))
  const unverifiedChecks: CheckResult[] = []
  const couldNotRunIds = new Set<string>()
  for (const active of checked) {
    const failed = (event.checks[active.id] ?? []).filter(check => check.passed !== true)
    if (failed.length === 0) continue
    // Checks that could not run for the environment are unverified, not failed: they spend nothing and never block on their own.
    // Only a delivered task counts as unverified; one never delivered is simply not finished (step 8 holds the Stop for it). A
    // real failure of any task still blocks below.
    if (failed.every(check => check.couldNotRun)) {
      if ((s.ends[active.id] ?? 0) > 0) { unverifiedChecks.push(...failed); couldNotRunIds.add(active.id) }
      continue
    }
    const output = tail(describe(failed))
    const key = `${active.id}\n${output}`
    const count = s.lastFailure?.key === key ? s.lastFailure.count + 1 : 1
    s.lastFailure = { key, count }
    // Its checks no longer back a pending or earned receipt: it needs a fresh task end.
    clearReceipts(s, active.id)
    if (count >= LOOP_LIMIT) {
      s.paused = true
      s.consecutiveBlocks = 0
      return instruct(s, 'pause', 'looping',
        `Task ${active.id} (${active.goal}) failed ${count} times in a row with the same output. Stop retrying: ask the person how to proceed.\n\n${output}`, active.id)
    }
    // The architect's diagnosis is open (the attempts are spent): with the architect disabled the pause says so, as a failed attempt does.
    if (opts.diagnosis?.includes(active.id)) {
      if (!opts.available.architect) {
        s.paused = true
        s.consecutiveBlocks = 0
        return instruct(s, 'pause', 'role_unavailable',
          `Task ${active.id} (${active.goal}) failed ${s.attempts[active.id] ?? 0} times and needs the architect's diagnosis, but the architect is disabled; enable it in pantheon.json and /pantheon flow resume, or /pantheon flow stop.\n\n${output}`, active.id)
      }
      charge(s)
      return instruct(s, 'block', 'check_failed',
        `Task ${active.id} (${active.goal}) is not done: its checks fail. Its attempts are spent: ask the architect to diagnose it (a delegation whose description starts with [${active.id}]), or run /pantheon flow resume or /pantheon flow stop.\n\n${output}`, active.id)
    }
    charge(s)
    return instruct(s, 'block', 'check_failed',
      `Task ${active.id} (${active.goal}) is not done: its checks fail. Fix the failure, then try to stop again.\n\n${output}`, active.id)
  }
  s.lastFailure = undefined

  // 6. a task whose checks passed waits for its receipts (the architect's review, QA's verdict, or both in any order)
  for (const waiting of flow.tasks) {
    if (s.status[waiting.id] === 'done') continue
    const by = REVIEWERS.filter(who => s.awaiting.some(a => a.task === waiting.id && a.by === who))
    if (by.length === 0) continue
    const gone = unavailable(by, opts)
    if (gone.length) {
      s.paused = true
      s.consecutiveBlocks = 0
      return instruct(s, 'pause', 'role_unavailable', unavailableReason(waiting, by, gone), waiting.id)
    }
    charge(s)
    return instruct(s, 'block', conditionFor(by[0]!), stopReason(waiting, by), waiting.id)
  }

  // Checks that could not run on delivered tasks end the Stop as unverified, but only when nothing else holds it: no other
  // active task and no eligible required task still to start. Otherwise the block below (continue) stays.
  if (unverifiedChecks.length) {
    const holdsOthers = flow.tasks.some(task => s.status[task.id] === 'active' && !couldNotRunIds.has(task.id))
      || eligible(flow, s.status).some(id => required.includes(id) && !couldNotRunIds.has(id))
    if (!holdsOthers) {
      return allow('unverified', `Checks could not run, so their tasks are unverified and the flow is not marked complete. No attempt was spent. Create the directory the check needs, or ask the person to fix the plan and approve it.\n\n${tail(describe(unverifiedChecks))}`)
    }
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

/** Marks done, in dependency order, every eligible task with checks that all passed; side effects and tasks missing a required receipt are never settled. */
function settleByChecks(flow: Flow, s: FlowState, checks: Record<string, CheckResult[]>, opts: DecideOptions): string[] {
  const settled: string[] = []
  for (;;) {
    const next = eligible(flow, s.status)
      .map(id => findTask(flow, id)!)
      .find(task => !task.sideEffect && missingReceipts(task, s, opts).length === 0 && task.acceptance.checks.length > 0 && checksPassed(task, checks[task.id]))
    if (!next) return settled
    s.status[next.id] = 'done'
    s.awaiting = s.awaiting.filter(a => a.task !== next.id)
    delete s.attempts[next.id]
    settled.push(next.id)
  }
}

// --- task end and review ---

function onTaskEnd(flow: Flow, s: FlowState, event: Extract<FlowEvent, { kind: 'taskEnd' }>, original: FlowState, opts: DecideOptions): Decision {
  const idle = idleDecision(flow, original)
  if (idle) {
    // A paused or stopped flow does not act on the delivery, but it happened: receipts and waits for the older code
    // must not survive it, or a reviewer spawned before would count after the resume.
    const delivered = findTask(flow, event.taskId)
    if (approvedFor(flow, original) && !original.done && (original.paused || original.stopped) && delivered && original.status[delivered.id] !== 'done') {
      const state = copyState(original)
      state.ends[delivered.id] = (state.ends[delivered.id] ?? 0) + 1
      clearReceipts(state, delivered.id)
      return make(state, idle.action, idle.condition, idle.reason)
    }
    return idle
  }
  const task = findTask(flow, event.taskId)
  // Parallel tasks: the ones being worked on, and any eligible one that finishes ahead of its turn.
  if (!task || s.status[task.id] === 'done' || !(s.status[task.id] === 'active' || eligible(flow, s.status).includes(task.id))) {
    return make(s, 'allow', 'not_active', `Task ${event.taskId} is not an active or eligible task, so its result is not acted on.`)
  }
  s.ends[task.id] = (s.ends[task.id] ?? 0) + 1
  const failures = failingChecks(task, event.checks)
  // A check that could not run for the environment the task left (its directory is not there, its command did not start) says
  // nothing about the work: the delivery is unverified, the task stays where it is and no attempt is spent.
  if (event.ownershipDenials === 0 && failures.length > 0 && failures.every(check => check.couldNotRun)) {
    clearReceipts(s, task.id)
    // A side effect may already have run before its check could not: the person must look, it is never delegated again.
    if (task.sideEffect) {
      if (!s.sideEffectsDone.includes(task.id)) s.sideEffectsDone.push(task.id)
      s.paused = true
      s.consecutiveBlocks = 0
      return instruct(s, 'pause', 'ask_person', `Task ${task.id} (${task.goal}) is a side effect and its checks could not run, so it may already have run. The flow will not re-run it. Ask the person to check it by hand first: /pantheon flow resume treats the task as done and starts what depends on it, so if the effect did not run, the person should do it by hand before resuming, or run /pantheon flow stop.\n\n${tail(describe(failures))}`, task.id)
    }
    return make(s, 'allow', 'unverified', `Task ${task.id} (${task.goal}) was delivered, but its checks could not run, so it is unverified and no attempt was spent. Create the directory the check needs, or ask the person to fix the plan and approve it.\n\n${tail(describe(failures))}`, task.id)
  }
  if (event.ownershipDenials > 0 || failures.length) return failAttempt(flow, s, task, tail(describe(failures)), event.ownershipDenials, opts)

  // A receipt covers the code it saw: a new delivery starts over, so none earned for older code counts.
  clearReceipts(s, task.id)
  return finishOrAwait(flow, s, task, opts)
}

/** Task ends and reviews do nothing on a flow that is unapproved, edited, done, paused or stopped. */
function idleDecision(flow: Flow, original: FlowState): Decision | undefined {
  if (!approvedFor(flow, original)) return make(copyState(original), 'allow', 'unapproved', 'The flow is not approved, or its approval does not match the plan in force, so nothing is enforced.')
  if (original.done) return make(copyState(original), 'allow', 'already_done', 'The flow is already complete.')
  if (original.paused) return make(copyState(original), 'allow', 'paused', 'The flow is paused until the person resumes it.')
  if (original.stopped) return make(copyState(original), 'allow', 'stopped', 'The flow was stopped by the person.')
  return undefined
}

function onReview(flow: Flow, s: FlowState, event: Extract<FlowEvent, { kind: 'review' }>, original: FlowState, opts: DecideOptions): Decision {
  const idle = idleDecision(flow, original)
  if (idle) return idle
  const task = findTask(flow, event.taskId)
  if (!task || !s.awaiting.some(a => a.task === task.id && a.by === event.by)) {
    return make(s, 'allow', 'review_ignored', `Review by ${event.by} for ${event.taskId} ignored: the task is not awaiting it.`)
  }
  if (event.end !== (s.ends[task.id] ?? 0)) {
    return make(s, 'allow', 'review_ignored', `Review by ${event.by} for ${event.taskId} ignored: it saw delivery ${event.end} and the task was delivered ${s.ends[task.id] ?? 0} time(s).`)
  }
  if (event.verdict === 'blocked') {
    const why = event.note?.trim()
    s.paused = true
    return instruct(s, 'pause', 'qa_blocked',
      `QA could not verify task ${task.id} (${task.goal})${why ? `: ${tail(why)}` : '.'} It is neither a pass nor a fail, so no attempt was spent. Ask the person what QA needs, then /pantheon flow resume.`, task.id)
  }
  if (event.verdict === 'pass') {
    s.awaiting = s.awaiting.filter(a => !(a.task === task.id && a.by === event.by))
    s.receipts[task.id] = { ...s.receipts[task.id], [event.by]: true }
    return finishOrAwait(flow, s, task, opts)
  }
  const note = event.note?.trim()
  const what = event.by === 'architect' ? 'The architect rejected the review' : 'QA failed the task'
  return failAttempt(flow, s, task, note ? tail(`${what}: ${note}`) : `${what}.`, 0, opts)
}

/**
 * The task's checks pass. It is done when every required receipt exists; otherwise it waits for the missing ones, all
 * asked at once so they can come in any order, and a missing receipt from a disabled role pauses and asks the person.
 */
function finishOrAwait(flow: Flow, s: FlowState, task: FlowTask, opts: DecideOptions): Decision {
  if (opts.requireQa !== true) return decideReceipts(flow, s, task, opts)
  // QA never runs a side effect twice, and nobody can be escalated to when the role is disabled: the judge cannot pause a flow.
  if (task.sideEffect || !opts.available.qa) return { ...decideReceipts(flow, s, task, { ...opts, requireQa: false }), note: 'require_qa_ignored' }
  // Criteria (or an earlier escalation) already require QA: there is nothing to add.
  if (task.acceptance.criteria.length > 0 || s.qaRequired.includes(task.id)) return decideReceipts(flow, s, task, opts)
  // The escalation only tightens: where the judge-less outcome is already a pause (no eligible task left, a disabled architect)
  // it stays one, and asks the person, instead of becoming a wait for QA.
  const base = decideReceipts(flow, copyState(s), task, { ...opts, requireQa: false })
  if (base.action === 'pause' || base.action === 'block') return decideReceipts(flow, s, task, { ...opts, requireQa: false })
  // An escalation sticks to the task until it is done, so settle-by-checks, rebase and later task ends still honor it.
  s.qaRequired.push(task.id)
  return decideReceipts(flow, s, task, opts)
}

function decideReceipts(flow: Flow, s: FlowState, task: FlowTask, opts: DecideOptions): Decision {
  const missing = missingReceipts(task, s, opts)
  if (missing.length === 0) return finishTask(flow, s, task)
  for (const by of missing) if (!s.awaiting.some(a => a.task === task.id && a.by === by)) s.awaiting.push({ task: task.id, by })
  const gone = unavailable(missing, opts)
  if (gone.length) {
    s.paused = true
    return instruct(s, 'pause', 'role_unavailable', unavailableReason(task, missing, gone), task.id)
  }
  return make(s, 'allow', conditionFor(missing[0]!), taskEndReason(task, missing), task.id)
}

/** A failed attempt: retry the implementer, then the architect (or the onFail task), then the person. */
function failAttempt(flow: Flow, s: FlowState, task: FlowTask, output: string, ownershipDenials: number, opts: DecideOptions): Decision {
  const max = task.loop?.maxIterations ?? flow.limits.maxAttempts
  const attempts = (s.attempts[task.id] ?? 0) + 1
  s.attempts[task.id] = attempts
  // Whatever receipt it had no longer covers the work.
  clearReceipts(s, task.id)
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
    const retry = (): Decision => instruct(s, 'failTask', 'retry', withOutput(`Task ${task.id} (${task.goal}) failed attempt ${attempts} of ${max}. Retry the same implementer with this output.`), task.id)
    if (opts.retryToArchitect !== true) return retry()
    // The escalation never advances (an `onFail` branch still to run is its own rung) and never pauses (a disabled architect
    // would): in both the ladder goes on as it would have, and the decision says the escalation was set aside.
    const branch = task.onFail ? findTask(flow, task.onFail) : undefined
    if ((branch && s.status[branch.id] !== 'done') || !opts.available.architect) return { ...retry(), note: 'retry_to_architect_ignored' }
    // The same state the last attempt leaves: one try after the diagnosis, then the person. Never lower than it was.
    s.attempts[task.id] = Math.max(attempts, max)
    return instruct(s, 'failTask', 'architect',
      withOutput(`Task ${task.id} (${task.goal}) failed attempt ${attempts} of ${max}, and what it returned suggests another retry of the same implementer will not fix it. Ask the architect to diagnose it before another attempt.`), task.id)
  }
  const branch = task.onFail ? findTask(flow, task.onFail) : undefined
  if (branch && s.status[branch.id] !== 'done') {
    s.status[task.id] = 'failed'
    s.status[branch.id] = 'active'
    return instruct(s, 'advance', 'on_fail', withOutput(`Task ${task.id} failed ${attempts} times. Move to ${branch.id} (${branch.goal}).`), branch.id)
  }
  if (!opts.available.architect) {
    s.paused = true
    return instruct(s, 'pause', 'role_unavailable',
      withOutput(`Task ${task.id} (${task.goal}) failed ${attempts} times and needs the architect's diagnosis, but the architect is disabled; enable it in pantheon.json and /pantheon flow resume, or /pantheon flow stop.`), task.id)
  }
  return instruct(s, 'failTask', 'architect', withOutput(`Task ${task.id} (${task.goal}) failed ${attempts} times. Ask the architect to diagnose it before another attempt.`), task.id)
}

/**
 * The task's work is verified: mark it done and move on. Finishing the last required task never completes the
 * flow here; the next Stop sees every done task's checks and completes it (all_done tells the agent to stop).
 */
function finishTask(flow: Flow, s: FlowState, task: FlowTask): Decision {
  const wasActive = s.status[task.id] === 'active'
  s.status[task.id] = 'done'
  s.awaiting = s.awaiting.filter(a => a.task !== task.id)
  s.qaRequired = s.qaRequired.filter(id => id !== task.id)
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
    awaiting: state.awaiting.map(a => ({ ...a })),
    receipts: copyReceipts(state.receipts),
    qaRequired: [...state.qaRequired],
    ends: { ...state.ends },
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
    awaiting: state.awaiting.map(a => ({ ...a })),
    receipts: copyReceipts(state.receipts),
    qaRequired: [...state.qaRequired],
    ends: { ...state.ends },
    sideEffectsDone: [...state.sideEffectsDone],
    ...(state.lastFailure ? { lastFailure: { ...state.lastFailure } } : {}),
  }
}

// --- receipts ---

const REVIEWERS: readonly Reviewer[] = ['architect', 'qa']

/**
 * The receipts a task needs before it is done: the architect's review when it is `risk`; QA's verdict when it has
 * acceptance criteria or the caller passes `requireQa` or an earlier call did (`qaRequired`). A side-effect task never goes to QA (it must not run twice),
 * so it never requires one.
 */
export function requiredReceipts(task: FlowTask, opts: Partial<DecideOptions> = {}, qaRequired: readonly string[] = []): Reviewer[] {
  const out: Reviewer[] = []
  if (task.risk) out.push('architect')
  if (!task.sideEffect && (task.acceptance.criteria.length > 0 || opts.requireQa === true || qaRequired.includes(task.id))) out.push('qa')
  return out
}

function missingReceipts(task: FlowTask, s: FlowState, opts: Partial<DecideOptions> = {}): Reviewer[] {
  return requiredReceipts(task, opts, s.qaRequired).filter(by => !s.receipts[task.id]?.[by])
}

/** A task's receipts and everything it was waiting for go away. */
function clearReceipts(s: FlowState, id: string): void {
  s.awaiting = s.awaiting.filter(a => a.task !== id)
  delete s.receipts[id]
}

function copyReceipts(receipts: Record<string, Receipts>): Record<string, Receipts> {
  return Object.fromEntries(Object.entries(receipts).map(([id, r]) => [id, { ...r }]))
}

const conditionFor = (by: Reviewer): string => (by === 'architect' ? 'review_needed' : 'qa_needed')
const unavailable = (by: Reviewer[], opts: DecideOptions): Reviewer[] => by.filter(who => opts.available[who] === false)
const WHO: Record<Reviewer, string> = { architect: 'the architect', qa: 'qa' }
const names = (by: Reviewer[]): string => by.map(who => WHO[who]).join(' and ')

function taskEndReason(task: FlowTask, missing: Reviewer[]): string {
  if (missing.length === 2) return `Task ${task.id} passes its checks but needs two receipts before it counts as done: an architect review (it is risky) and a QA verdict. Ask the architect to review it and qa to verify it, in any order.`
  return missing[0] === 'architect'
    ? `Task ${task.id} passes its checks but is risky: ask the architect to review it before it counts as done.`
    : `Task ${task.id} passes its checks but needs a QA verdict: ask qa to verify it before it counts as done.`
}

function stopReason(task: FlowTask, by: Reviewer[]): string {
  if (by.length === 2) return `Task ${task.id} passes its checks but has no architect review and no QA verdict yet. Ask the architect to review it and qa to verify it before stopping.`
  return by[0] === 'architect'
    ? `Task ${task.id} is risky and its checks pass, but it has no architect review yet. Ask the architect to review it before stopping.`
    : `Task ${task.id} passes its checks but has no QA verdict yet. Ask qa to verify it before stopping.`
}

function unavailableReason(task: FlowTask, needed: Reviewer[], gone: Reviewer[]): string {
  return `Task ${task.id} (${task.goal}) needs ${names(needed)} before it counts as done, but ${names(gone)} ${gone.length > 1 ? 'are' : 'is'} disabled; enable ${gone.length > 1 ? 'them' : 'it'} in pantheon.json and /pantheon flow resume, or /pantheon flow stop.`
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
