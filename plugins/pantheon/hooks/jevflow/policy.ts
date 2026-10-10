// Stop-hook policy: port of JevFlow jevflow/policy.py (SPEC 4, 10.1 to 10.5).
//
// Pure: no I/O, no clock reads, no host access. `decide` takes the flow, the state
// (read only), a judgment (null when Jev is unavailable), the deterministic check
// results and `now`, and returns a decision. `applyDecision` returns a new state
// with the decision's patch applied; the hook then journals and saves it.
//
// Code owns control flow: Jev never advances a phase on its own. Advance needs the
// current_phase winner AND verify at or above `auto` AND the phase check passing
// when one is defined. Deterministic checks always outrank Jev. Conditions are
// evaluated in a fixed order and the first match wins; each decision carries a
// `condition` tag naming the rule that fired.
//
// Not ported: the flow `mode` (always enforce, so apply_mode is not needed),
// dynamic phases and sub-steps (regions.py), gates, notify. Side-effect idempotency
// keys are kept, because the side-effect conditions quote them.

import { ADVANCE, ALLOW_STOP, BLOCK, UNCLEAR } from './types'
import type { CheckResult, Decision, DecisionKind, Flow, FlowState, Judgment, Phase, PhaseStatus } from './types'

export const CLAUDE_BLOCK_CAP = 8 // Claude Code's consecutive Stop-block cap
export const ESCALATE_AFTER = 3 // "change approach" count that escalates to ask_human
export const SAME_REASON_LIMIT = 3 // identical BLOCK reason this many times = looping
export const STUCK_STREAK = 2 // stuck >= flag this many times in a row = looping
export const TRUST_CHECK = 0.9 // check passes + phase_done >= this -> advance (limits.confidence.trust_check)
export const REVIEW_PASS_LIMIT = 2 // consecutive review-band stops with the phase check passing -> advance
export const OUTPUT_CHARS = 1200 // failing check output quoted in a BLOCK reason

const STREAK_NEUTRAL = new Set(['off_goal', 'unclear', 'phase_mismatch'])

type PolicyState = FlowState
/**
 * `blocks_inc` is charged to the state when the decision is applied, as JevFlow does,
 * so a decision made on an older snapshot never overwrites a newer block count.
 */
type PolicyPatch = Decision['patch']
type PolicyDecision = Decision
export type DecideOptions = {
  /** Claude's flag that this Stop follows one of our blocks; when false the consecutive-block run starts over. */
  stop_hook_active?: boolean
  /** Phase id -> CheckResult of its `loop.until`. */
  loop_checks?: Readonly<Record<string, CheckResult>>
  /** Why Jev is unavailable, quoted in the checks-only note. Used only when `judgment` is null. */
  degraded_reason?: string
}
export type CapKind = 'budget_blocks' | 'hook_cap' | 'budget_time' | 'budget_jev'

type Checks = Readonly<Record<string, CheckResult>>
type Statuses = Readonly<Record<string, PhaseStatus>>
type BlockOpts = { toPhase?: string; kind?: DecisionKind; notes?: string[]; failure?: string }

// --- small helpers ---

/** Own-property lookup: phase ids such as "constructor" must not reach Object.prototype. */
const own = <T>(rec: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined =>
  rec && Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined

const isDefined = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined

/** Last `n` characters (code points, as Python counts them) of the stripped text, with "..." when cut. */
function tail(text: string | null | undefined, n: number = OUTPUT_CHARS): string {
  const t = (text ?? '').trim()
  const chars = Array.from(t)
  return chars.length <= n ? t : '...' + chars.slice(-(n - 3)).join('')
}

/** Python's repr of a list of phase ids, as the messages print it. */
const pyList = (items: readonly string[]): string => '[' + items.map((x) => `'${x}'`).join(', ') + ']'

const bandsOf = (flow: Flow) => {
  const c = flow.limits.confidence
  return { auto: c?.auto ?? 0.8, review: c?.review ?? 0.5, flag: c?.flag ?? 0.7 }
}

const phaseOf = (flow: Flow, id: string): Phase | undefined => flow.phases.find((p) => p.id === id)

const requirePhase = (flow: Flow, id: string): Phase => {
  const p = phaseOf(flow, id)
  if (p === undefined) throw new Error(`unknown phase '${id}'`)
  return p
}

/** on_fail targets that no phase depends on (for example a debug branch). Never offered by eligibility, not required. */
const branchOnly = (flow: Flow): Set<string> => {
  const targets = new Set<string>()
  for (const p of flow.phases) if (p.on_fail) targets.add(p.on_fail)
  const depended = new Set<string>()
  for (const p of flow.phases) for (const d of p.depends_on) depended.add(d)
  return new Set([...targets].filter((t) => !depended.has(t)))
}

/** Phase ids that must be done for the goal to be complete. */
const requiredIds = (flow: Flow): string[] => {
  const bo = branchOnly(flow)
  return flow.phases.filter((p) => !bo.has(p.id)).map((p) => p.id)
}

/** Phases not yet done whose dependencies are all done, in declaration order; branch-only phases excluded. */
const eligibleIds = (flow: Flow, status: Statuses): string[] => {
  const bo = branchOnly(flow)
  const out: string[] = []
  for (const p of flow.phases) {
    if (own(status, p.id) === 'done' || bo.has(p.id)) continue
    if (p.depends_on.every((d) => own(status, d) === 'done')) out.push(p.id)
  }
  return out
}

/** Required phases whose defined check did not pass (or did not run). */
const failingRequired = (flow: Flow, checks: Checks): string[] =>
  requiredIds(flow).filter((pid) => {
    if (!isDefined(requirePhase(flow, pid).check)) return false
    const c = own(checks, pid)
    return c === undefined || c.passed !== true
  })

/** Attempt number of a phase, as JevFlow's idempotency key counts it (1 when unknown). */
const attemptOf = (state: PolicyState, pid: string): number => {
  const n = own(state.phase_attempts, pid) ?? 0
  return Number.isInteger(n) && n >= 1 ? n : 1
}

const idempotencyKey = (flow: Flow, state: PolicyState, pid: string): string =>
  `${flow.flow_version}:${pid}:${attemptOf(state, pid)}`

const checkFailText = (pid: string, c: CheckResult | undefined): string => {
  if (c === undefined || c.passed === null) return ''
  const out = tail(c.output)
  return ` Check for '${pid}' fails` + (out ? `:\n${out}` : '.')
}

const blocksOf = (d: PolicyDecision): boolean => d.kind === BLOCK || d.kind === ADVANCE

// --- decision constructors ---

const stop = (condition: string, reason: string, patch: PolicyPatch = {}): PolicyDecision => ({
  kind: ALLOW_STOP,
  condition,
  reason,
  notes: [],
  patch: { ...patch },
})

const askHuman = (condition: string, question: string): PolicyDecision => ({
  kind: ALLOW_STOP,
  condition,
  reason: question,
  notes: [],
  question,
  patch: { needs_human: question },
})

const block = (
  state: PolicyState,
  condition: string,
  reason: string,
  opts: BlockOpts,
  patch: PolicyPatch = {},
): PolicyDecision => {
  const kind = opts.kind ?? BLOCK
  const notes = opts.notes ?? []
  const failure = opts.failure ?? ''
  const full = reason + failure + notes.map((n) => '\nNote: ' + n).join('')
  // Only an identical failure repeated counts toward SAME_REASON_LIMIT. A plain
  // "continue" repeated over a long phase is normal work, not looping.
  let same = failure !== '' ? 1 : 0
  if (failure !== '' && state.last_failure === failure) same = state.same_reason_count + 1
  // An advance is progress, not a hold: it must not spend the block budget.
  const p: PolicyPatch = {
    blocks_inc: kind === ADVANCE ? 0 : 1,
    last_block_reason: full,
    same_reason_count: same,
    last_failure: failure || null,
  }
  Object.assign(p, patch)
  return { kind, condition, reason: full, to_phase: opts.toPhase, notes, patch: p }
}

// --- deterministic settling and caps ---

/**
 * Walk the DAG marking phases done whose own check passes. Only phases with a
 * defined check that ran and passed; never side-effect or branch-only phases. A
 * loop phase settles only when its `loop.until` result is in `loopChecks` and
 * passes, and its phase check (if any) does not fail.
 */
export function settleByChecks(
  flow: Flow,
  status: Statuses,
  checks: Checks,
  loopChecks: Checks = {},
): { settled: string[]; status: Record<string, PhaseStatus> } {
  const st: Record<string, PhaseStatus> = { ...status }
  const settled: string[] = []
  let progress = true
  while (progress) {
    progress = false
    for (const pid of eligibleIds(flow, st)) {
      const p = requirePhase(flow, pid)
      const c = own(checks, pid)
      if (p.side_effect) continue
      if (isDefined(p.loop)) {
        const lc = own(loopChecks, pid)
        if (lc === undefined || lc.passed !== true || (c !== undefined && c.passed === false)) continue
      } else if (!isDefined(p.check) || c === undefined || c.passed !== true) {
        continue
      }
      st[pid] = 'done'
      settled.push(pid)
      progress = true
    }
  }
  return { settled, status: st }
}

/** Which budget or cap this Stop hits, or null. */
export function capReached(
  flow: Flow,
  state: PolicyState,
  now: number,
  stopHookActive: boolean = true,
): CapKind | null {
  if (state.blocks_this_session >= flow.limits.max_blocks_per_session) return 'budget_blocks'
  // Claude Code ends the loop itself after 8 consecutive blocks; stop one short so the final word is ours.
  if (stopHookActive && state.consecutive_blocks >= CLAUDE_BLOCK_CAP - 1) return 'hook_cap'
  const started = state.started_at || now
  if ((now - started) / 60 >= flow.limits.max_total_minutes) return 'budget_time'
  if (state.jev_calls >= flow.limits.max_jev_calls) return 'budget_jev'
  return null
}

const settleAndStop = (
  flow: Flow,
  state: PolicyState,
  checks: Checks,
  loopChecks: Checks,
  cur: string,
  phase: Phase | undefined,
  which: CapKind,
  cap: number,
): PolicyDecision => {
  const { settled, status: st } = settleByChecks(flow, state.phase_status, checks, loopChecks)
  const remaining = requiredIds(flow).filter((pid) => own(st, pid) !== 'done')
  const patch: PolicyPatch = {}
  const iters = state.loop_iterations
  const runs: Record<string, number> = {}
  for (const pid of settled) {
    if (isDefined(requirePhase(flow, pid).loop)) runs[pid] = (own(iters, pid) ?? 0) + 1
  }
  // the passing run counts (shows 1/N, not 0/N)
  if (Object.keys(runs).length > 0) patch.loop_iterations = runs

  if (phase !== undefined && remaining.length === 0 && failingRequired(flow, checks).length === 0) {
    const done: Record<string, PhaseStatus> = {}
    for (const pid of settled) done[pid] = 'done'
    return stop('goal_complete', 'Goal complete: every phase is done and every check passes.', {
      phase_status: settled.length > 0 ? done : { [cur]: 'done' },
      done: true,
      ...patch,
    })
  }

  const { limits } = flow
  const messages: Record<CapKind, string> = {
    budget_blocks:
      `Stopping: the flow has already kept Claude going ${cap} times this session ` +
      '(max_blocks_per_session) and will not hold it again until you reply.',
    hook_cap: 'Stopping: Claude Code consecutive Stop-block cap reached.',
    budget_time: `Stopping: time budget reached (${limits.max_total_minutes} min).`,
    budget_jev: `Stopping: Jev call budget reached (${limits.max_jev_calls}).`,
  }
  let msg = messages[which]
  if (settled.length > 0) {
    const nxt = eligibleIds(flow, st)[0]
    const ps: Record<string, PhaseStatus> = {}
    for (const pid of settled) ps[pid] = 'done'
    if (nxt !== undefined) {
      ps[nxt] = 'active'
      patch.current_phase = nxt
    }
    patch.phase_status = ps
    msg += ` Checks pass for ${settled.join(', ')}: marked done.`
  }
  if (remaining.length > 0) msg += ` Still open: ${remaining.join(', ')}.`
  if (which === 'budget_blocks' || which === 'hook_cap') {
    msg += " Send any message (for example 'continue') to resume with a fresh budget."
  }
  return stop(which, msg, patch)
}

// --- advance, regression and on_fail routing ---

const advanceTarget = (flow: Flow, state: PolicyState, donePhase: string): string | undefined => {
  const status: Record<string, PhaseStatus> = { ...state.phase_status, [donePhase]: 'done' }
  return eligibleIds(flow, status)[0]
}

const advanceOrComplete = (
  flow: Flow,
  state: PolicyState,
  checks: Checks,
  cur: string,
  condition: string,
  notes: string[] = [],
  extra: PolicyPatch = {},
): PolicyDecision => {
  const target = advanceTarget(flow, state, cur)
  const statusPatch: Record<string, PhaseStatus> = { [cur]: 'done' }
  if (target === undefined) {
    const remaining = requiredIds(flow).filter((pid) => pid !== cur && own(state.phase_status, pid) !== 'done')
    if (remaining.length === 0) {
      const failing = failingRequired(flow, checks)
      if (failing.length === 0) {
        return stop('goal_complete', 'Goal complete: every phase is done and every check passes.', {
          phase_status: statusPatch,
          done: true,
          ...extra,
        })
      }
      return block(
        state,
        'final_check_fail',
        `Every phase looks done, but these checks do not pass: ${pyList(failing)}. Make them pass before stopping.`,
        { failure: failing.map((pid) => checkFailText(pid, own(checks, pid))).join('') },
      )
    }
    // nothing eligible but phases remain: dependency deadlock, ask a human
    return askHuman(
      'dag_deadlock',
      `Phase '${cur}' is done but no remaining phase is eligible (remaining: ${pyList(remaining)}). ` +
        'Check depends_on in flow.json.',
    )
  }
  const p = requirePhase(flow, target)
  statusPatch[target] = 'active'
  return block(
    state,
    condition,
    `Phase '${cur}' is complete. Now work on phase '${target}' (${p.name}): ${p.done_when}.`,
    { toPhase: target, kind: ADVANCE, notes },
    {
      phase_status: statusPatch,
      current_phase: target,
      stuck_streak: 0,
      escalations: 0,
      ...extra,
    },
  )
}

const routeOnFail = (
  flow: Flow,
  state: PolicyState,
  cur: string,
  condition: string,
  why: string,
  c: CheckResult | undefined,
): PolicyDecision => {
  const phase = requirePhase(flow, cur)
  const target = requirePhase(flow, phase.on_fail ?? '')
  if (target.side_effect && own(state.phase_status, target.id) === 'done') {
    return askHuman(
      'side_effect_on_fail',
      `${why} Its on_fail target '${target.id}' has a side effect that already ran ` +
        `(key ${idempotencyKey(flow, state, target.id)}); the flow will not re-run it.` +
        checkFailText(cur, c),
    )
  }
  return block(
    state,
    condition,
    `${why} Switch to phase '${target.id}' (${target.name}): ${target.done_when}. Then return to '${cur}'.`,
    { failure: checkFailText(cur, c), toPhase: target.id, kind: ADVANCE },
    {
      phase_status: { [cur]: 'pending', [target.id]: 'active' },
      current_phase: target.id,
      loop_iterations: { [cur]: 0 },
      stuck_streak: 0,
    },
  )
}

// --- the rules, in order: the first match wins ---

const decideRule = (
  flow: Flow,
  state: PolicyState,
  judgment: Judgment | null,
  checks: Checks,
  now: number,
  stopHookActive: boolean,
  loopChecks: Checks,
  degradedReason: string,
): PolicyDecision => {
  const cur = String(state.current_phase)
  const status = state.phase_status
  const phase = phaseOf(flow, cur)

  // 1. already done
  if (state.done) return stop('already_done', 'Goal already complete.')

  // 2. hard caps and budgets (always win). Before stopping on any of them, let the
  // deterministic checks settle what they can: a flow whose last phase already
  // passes must end complete, not stranded looking unfinished.
  const cap = flow.limits.max_blocks_per_session
  const stopCap = capReached(flow, state, now, stopHookActive)
  if (stopCap !== null) return settleAndStop(flow, state, checks, loopChecks, cur, phase, stopCap, cap)
  if (phase === undefined) return askHuman('bad_state', `current_phase '${cur}' is not in the flow.`)

  // 3. regression: a phase already done whose check now fails (deterministic)
  const branch = branchOnly(flow)
  for (const p of flow.phases) {
    if (branch.has(p.id)) continue // a debug branch's check is not a standing invariant
    if (own(status, p.id) !== 'done' || !isDefined(p.check)) continue
    const c = own(checks, p.id)
    if (c === undefined || c.passed !== false) continue
    if (p.side_effect) {
      // re-entering would repeat an external action
      return askHuman(
        'side_effect_regression',
        `Phase '${p.id}' (${p.name}) has a side effect that already ran ` +
          `(key ${idempotencyKey(flow, state, p.id)}) but its check now fails. ` +
          'the flow will not re-run it; decide whether to redo it by hand.' +
          checkFailText(p.id, c),
      )
    }
    const patchStatus: Record<string, PhaseStatus> = { [p.id]: 'active' }
    if (cur !== p.id) patchStatus[cur] = 'pending'
    return block(
      state,
      'regression',
      `Regression: phase '${p.id}' (${p.name}) was done but its check now fails. Fix it before continuing.`,
      { failure: checkFailText(p.id, c), toPhase: p.id },
      { phase_status: patchStatus, current_phase: p.id },
    )
  }

  const curCheck = own(checks, cur)
  const checkDefined = isDefined(phase.check)
  const checkPass: boolean | null = checkDefined ? curCheck !== undefined && curCheck.passed === true : null
  const checkFail = checkDefined && curCheck !== undefined && curCheck.passed === false

  // 4. bounded loop phase (deterministic until-check)
  if (isDefined(phase.loop)) {
    const loop = phase.loop
    const lc = own(loopChecks, cur)
    const iters = own(state.loop_iterations, cur) ?? 0
    if (lc !== undefined && lc.passed === true && checkPass !== false) {
      // the passing run is a run: record it, so the viewer shows 1/N, not 0/N
      return advanceOrComplete(flow, state, checks, cur, 'loop_pass', [], { loop_iterations: { [cur]: iters + 1 } })
    }
    // the until-check can pass while the phase check still fails; report whichever failed
    const untilOk = lc !== undefined && lc.passed === true
    const failing = untilOk ? curCheck : lc
    const what = untilOk ? `the phase check still fails (${phase.done_when})` : `'${loop.until}' still fails`
    // loop_iterations counts runs (Stops where the until-check was evaluated), passing or
    // not; this failing run is run iters+1, and max_iterations is the total runs allowed
    if (iters + 1 >= loop.max_iterations) {
      if (phase.on_fail) {
        return routeOnFail(
          flow,
          state,
          cur,
          'loop_exhausted_on_fail',
          `Loop in phase '${cur}' used all ${loop.max_iterations} runs.`,
          failing,
        )
      }
      return askHuman(
        'loop_exhausted',
        `Phase '${cur}' loop used all ${loop.max_iterations} runs and ${what}.${checkFailText(cur, failing)}`,
      )
    }
    const goal = untilOk
      ? `'${loop.until}' passes but the phase check fails; fix it: ${phase.done_when}`
      : `keep going until '${loop.until}' passes`
    return block(
      state,
      'loop_continue',
      `Phase '${cur}' (${phase.name}), run ${iters + 1} of ${loop.max_iterations} failed: ${goal}.`,
      { failure: checkFailText(cur, failing) },
      { loop_iterations: { [cur]: iters + 1 } },
    )
  }

  // 5. degraded mode: checks only, never block without evidence
  if (judgment === null) {
    const note = `Jev unavailable (${degradedReason}); checks-only mode.`
    if (checkPass === true) return advanceOrComplete(flow, state, checks, cur, 'degraded_check_pass', [note])
    if (checkFail) {
      return block(
        state,
        'degraded_check_fail',
        `Phase '${cur}' (${phase.name}) is not done: ${phase.done_when}.`,
        { failure: checkFailText(cur, curCheck), notes: [note] },
      )
    }
    return stop('degraded_no_check', `${note} Phase '${cur}' has no check, so there is no evidence to block on.`)
  }
  const j = judgment
  const bands = bandsOf(flow)
  const { auto, review, flag } = bands

  // 6. ask_human (a safe stop, only at auto confidence)
  if (j.next_action === 'ask_human' && j.next_action_conf >= auto) {
    return askHuman(
      'ask_human',
      `The agent appears blocked on phase '${cur}' (${phase.name}) and needs a human decision.`,
    )
  }

  // 7. stuck / looping escalation
  const sameReason = state.same_reason_count
  const stuckHit = j.stuck >= flag
  const streak = stuckHit ? state.stuck_streak + 1 : 0
  if ((stuckHit && streak >= STUCK_STREAK) || sameReason >= SAME_REASON_LIMIT) {
    const esc = state.escalations + 1
    if (esc >= ESCALATE_AFTER) {
      return askHuman(
        'stuck_ask_human',
        `The agent has looped on phase '${cur}' (${phase.name}) after ${esc - 1} change-approach instructions.` +
          checkFailText(cur, curCheck),
      )
    }
    return block(
      state,
      'stuck_escalate',
      `You are looping on phase '${cur}'. Stop, re-read the goal, and take a fundamentally different approach to: ` +
        `${phase.done_when}.`,
      { failure: checkFailText(cur, curCheck) },
      { stuck_streak: streak, escalations: esc, same_reason_count: 0 },
    )
  }
  if (stuckHit) {
    return block(
      state,
      'stuck',
      `You seem to be repeating a failing approach on phase '${cur}'. Stop, re-read the goal, and try a different ` +
        `approach to: ${phase.done_when}.`,
      { failure: checkFailText(cur, curCheck) },
      { stuck_streak: streak },
    )
  }

  // 8. off-goal drift
  if (j.off_goal >= flag) {
    return block(
      state,
      'off_goal',
      `Re-read the goal: "${flow.goal}". The current work does not serve phase '${cur}' (${phase.name}): ${phase.done_when}.`,
      {},
      { stuck_streak: 0 },
    )
  }

  // 9. check failed after the agent thinks it is done: on_fail branch or premature claim
  const phaseDone = own(j.phase_done, cur) ?? 0
  const thinksDone = j.claims_done >= flag || (j.verify !== null && j.verify >= auto) || phaseDone >= auto
  if (checkFail && thinksDone) {
    if (phase.on_fail) {
      return routeOnFail(flow, state, cur, 'on_fail', `Phase '${cur}' was attempted but its check fails.`, curCheck)
    }
    if (j.claims_done >= flag) {
      return block(
        state,
        'premature_completion',
        `You said the work is done, but it is not: phase '${cur}' (${phase.name}) requires: ${phase.done_when}.`,
        { failure: checkFailText(cur, curCheck) },
        { stuck_streak: 0 },
      )
    }
  }

  // 10. abstain: never advance or regress on 'unclear'
  if (j.current_phase === UNCLEAR) {
    return block(
      state,
      'unclear',
      `Continue phase '${cur}' (${phase.name}): ${phase.done_when}.`,
      {
        failure: checkFail ? checkFailText(cur, curCheck) : '',
        notes: ['Jev could not tell which phase this is; keeping the current phase.'],
      },
      { stuck_streak: 0 },
    )
  }

  // 11. compete then verify, plus the deterministic check
  const conf = j.current_phase_conf
  const verify = j.verify_phase === cur ? j.verify : null
  // checkPass is null when no check is defined; a defined check must be true
  if (
    j.current_phase === cur &&
    conf >= auto &&
    verify !== null &&
    verify >= auto &&
    (checkPass === true || !checkDefined)
  ) {
    return advanceOrComplete(flow, state, checks, cur, 'advance')
  }

  // 11b. the deterministic check passes and Jev's own phase-done estimate agrees
  // strongly: advance. A lower current_phase confidence (which phase is this?) is not
  // evidence the work is unfinished; blocking here only costs a round trip.
  const trust = flow.limits.confidence?.trust_check ?? TRUST_CHECK
  if (checkPass === true && phaseDone >= trust) {
    return advanceOrComplete(flow, state, checks, cur, 'check_and_phase_done', [
      `Check for '${cur}' passes and Jev puts phase_done at ${phaseDone.toFixed(2)}; ` +
        `not waiting on phase confidence (${conf.toFixed(2)}).`,
    ])
  }

  // 12. review band or drop band: keep the current phase
  const notes: string[] = []
  let condition = 'continue'
  const top = j.current_phase === cur && verify !== null ? Math.min(conf, verify) : conf
  if (j.current_phase !== cur && conf >= review) {
    notes.push(
      `Jev thinks the work is in phase '${j.current_phase}' (${conf.toFixed(2)}); phases advance only through '${cur}'.`,
    )
    condition = 'phase_mismatch'
  } else if (review <= top && top < auto) {
    condition = 'review_band'
    if (checkPass === true) {
      // The deterministic check passes and Jev only half agrees. Blocking forever would
      // stall the flow, so after REVIEW_PASS_LIMIT consecutive such stops the check decides.
      // Jev alone never advances.
      const prev = state.review_streak
      const streakN = prev !== null && prev.phase === cur ? prev.n + 1 : 1
      if (streakN >= REVIEW_PASS_LIMIT) {
        return advanceOrComplete(flow, state, checks, cur, 'review_check_pass', [
          `Check for '${cur}' passes and Jev was in the review band ${streakN} times in a row ` +
            `(${top.toFixed(2)}); the check decides.`,
        ])
      }
      notes.push(
        `Jev is not yet confident phase '${cur}' is done (${top.toFixed(2)}); its check passes. ` +
          `Confirm every part of: ${phase.done_when}.`,
      )
      return block(
        state,
        condition,
        `Continue phase '${cur}' (${phase.name}). Not done yet: ${phase.done_when}.`,
        { notes },
        { stuck_streak: 0, review_streak: { phase: cur, n: streakN } },
      )
    }
    notes.push(`Jev is not yet confident phase '${cur}' is done (${top.toFixed(2)}).`)
  } else if (top < review) {
    condition = 'drop_band'
  }
  return block(
    state,
    condition,
    `Continue phase '${cur}' (${phase.name}). Not done yet: ${phase.done_when}.`,
    { failure: checkFail ? checkFailText(cur, curCheck) : '', notes },
    { stuck_streak: 0 },
  )
}

/**
 * Pure policy. `checks`: phase id -> CheckResult of its `check`. `opts.loopChecks`:
 * phase id -> CheckResult of its `loop.until`. `opts.stopHookActive` is Claude's flag
 * that this Stop follows one of our blocks; when false the consecutive-block run starts over.
 */
export function decide(
  flow: Flow,
  state: PolicyState,
  judgment: Judgment | null,
  checks: Checks,
  now: number,
  opts: DecideOptions = {},
): PolicyDecision {
  const stopHookActive = opts.stop_hook_active ?? false
  const d = decideRule(
    flow,
    state,
    judgment,
    checks,
    now,
    stopHookActive,
    opts.loop_checks ?? {},
    opts.degraded_reason ?? 'no judgment',
  )
  const run = stopHookActive ? state.consecutive_blocks : 0
  d.patch.consecutive_blocks = blocksOf(d) ? run + 1 : 0
  // Most outcomes end the streak. Holds that say nothing about whether the phase is
  // finished (off_goal, unclear, phase_mismatch) do not, so they cannot split a
  // passing-check review run until the phase stalls.
  if (!(d.kind === BLOCK && STREAK_NEUTRAL.has(d.condition)) && !('review_streak' in d.patch)) {
    d.patch.review_streak = null
  }
  return d
}

/** Apply the decision's patch to a copy of `state` and return it. The input is not mutated. */
export function applyDecision(state: PolicyState, d: PolicyDecision, now: number): PolicyState {
  const next: PolicyState = JSON.parse(JSON.stringify(state))
  const p: PolicyPatch = JSON.parse(JSON.stringify(d.patch))
  if (p.blocks_inc) next.blocks_this_session = next.blocks_this_session + 1
  delete p.blocks_inc
  for (const [pid, st] of Object.entries(p.phase_status ?? {})) {
    const prev = own(next.phase_status, pid)
    if (st === 'active' && prev !== 'active') {
      // each entry into a phase is a new attempt (idempotency key)
      next.phase_attempts[pid] = (own(next.phase_attempts, pid) ?? 0) + 1
    }
    next.phase_status[pid] = st
  }
  delete p.phase_status
  for (const [pid, n] of Object.entries(p.loop_iterations ?? {})) next.loop_iterations[pid] = n
  delete p.loop_iterations
  Object.assign(next, p)
  next.updated_at = now
  return next
}
