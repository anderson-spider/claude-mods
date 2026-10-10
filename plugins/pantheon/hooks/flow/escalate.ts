// What the judge's numbers mean (decisions 18, 20 and 21). Pure policies over normalized answers: the judge informs and
// code decides, so every function here can only make the next decision stricter (more QA, an earlier architect, a
// block), and model fit only ever goes down inside deterministic bounds. A missing answer is "no signal": it never
// escalates, and never allows a down-tier. Flags that say "something is wrong" combine with the maximum, never the
// average, and the injection flag (`addressed_to_judge`) only hardens.

import type { Answers } from './judge'
import { ADDRESSED_TO_JUDGE, FIT_FLOORS, THRESHOLDS } from './questions'
import type { Thresholds } from './questions'

const noul = (answers: Answers, id: string): number | undefined => {
  const value = answers[id]?.noul
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The largest value present, with the name that produced it; undefined when none is. */
function maxOf(answers: Answers, ids: readonly string[]): { id: string; value: number } | undefined {
  let best: { id: string; value: number } | undefined
  for (const id of ids) {
    const value = noul(answers, id)
    if (value !== undefined && (best === undefined || value > best.value)) best = { id, value }
  }
  return best
}

const show = (value: number) => value.toFixed(2)

// --- Task end with checks passing (decision 18) ---

export type TaskEndEscalation = { requireQa: boolean; why: string[] }

/**
 * Checks passed, but the agent's own report does not back the task: it does not say the goal was done, or it names
 * remaining work or an unresolved problem, or it speaks to its evaluator. Never applies to a `sideEffect` task (QA
 * never runs side effects); the reasons are still listed so a shadow journal shows what would have happened.
 */
export function taskEndEscalation(answers: Answers, task: { sideEffect?: boolean }, thresholds: Thresholds = THRESHOLDS): TaskEndEscalation {
  const why: string[] = []
  const done = noul(answers, 'goal_reported_done')
  if (done !== undefined && done <= thresholds.goalReportedDoneAtMost) {
    why.push(`goal_reported_done=${show(done)} <= ${show(thresholds.goalReportedDoneAtMost)}`)
  }
  const flag = maxOf(answers, ['reports_remaining_work', 'reports_problem', ADDRESSED_TO_JUDGE])
  if (flag && flag.value >= thresholds.taskEndFlagAtLeast) {
    why.push(`${flag.id}=${show(flag.value)} >= ${show(thresholds.taskEndFlagAtLeast)}`)
  }
  if (task.sideEffect === true) {
    return { requireQa: false, why: why.length > 0 ? [...why, 'ignored: side-effect task'] : why }
  }
  return { requireQa: why.length > 0, why }
}

// --- Retry branch (decision 18) ---

export type RetryEscalation = { retryToArchitect: boolean; why: string[] }

/** The agent is stuck, blames something outside the task, fails the same way again, or speaks to its evaluator. */
export function retryEscalation(answers: Answers, thresholds: Thresholds = THRESHOLDS): RetryEscalation {
  const flag = maxOf(answers, ['gave_up', 'cause_outside_task', 'same_failure', ADDRESSED_TO_JUDGE])
  if (flag && flag.value >= thresholds.retryFlagAtLeast) {
    return { retryToArchitect: true, why: [`${flag.id}=${show(flag.value)} >= ${show(thresholds.retryFlagAtLeast)}`] }
  }
  return { retryToArchitect: false, why: [] }
}

// --- Done check outside a flow (decision 21) ---

export type DoneCheckVerdict = { block: boolean; falseClaim: boolean; why: string[] }

/**
 * `needsDoneCheck` says the turn edited files and no check ran after the last edit. Block when the message claims
 * done on work that checks apply to, unless it reports a blocker. A message that speaks to its evaluator counts as
 * claiming done, and its claim of a blocker is not believed: under injection the block depends on
 * `verification_applies` alone. A claim of verification with no check run is a false claim (journaled; it does not
 * change `block`).
 */
export function doneCheckVerdict(answers: Answers, needsDoneCheck: boolean, thresholds: Thresholds = THRESHOLDS): DoneCheckVerdict {
  if (!needsDoneCheck) return { block: false, falseClaim: false, why: [] }
  const why: string[] = []
  const addressed = noul(answers, ADDRESSED_TO_JUDGE)
  const injected = addressed !== undefined && addressed >= thresholds.addressedAtLeast
  const claims = noul(answers, 'claims_done')
  const claimed = injected || (claims !== undefined && claims >= thresholds.claimsDoneAtLeast)
  const applies = noul(answers, 'verification_applies')
  const outcome = answers.outcome
  const blocked = !injected && outcome?.choice === 'blocked' && (outcome.confidence ?? 0) >= thresholds.blockedConfidenceAtLeast

  let block = false
  if (claimed && applies !== undefined && applies >= thresholds.verificationAppliesAtLeast) {
    if (blocked) {
      why.push(`outcome=blocked (confidence ${show(outcome?.confidence ?? 0)}): no block`)
    } else {
      block = true
      why.push(injected ? `${ADDRESSED_TO_JUDGE}=${show(addressed)} counts as claims_done=1` : `claims_done=${show(claims ?? 0)} >= ${show(thresholds.claimsDoneAtLeast)}`)
      why.push(`verification_applies=${show(applies)} >= ${show(thresholds.verificationAppliesAtLeast)}`)
    }
  }
  const verified = noul(answers, 'claims_verified')
  const falseClaim = verified !== undefined && verified >= thresholds.falseClaimAtLeast
  if (falseClaim) why.push(`claims_verified=${show(verified)} >= ${show(thresholds.falseClaimAtLeast)} with no check run`)
  return { block, falseClaim, why }
}

// --- Model fit at spawn (decision 20) ---

/**
 * Higher is stronger. The name must start with the tier: an alias (`haiku`, `sonnet[1m]`) or an id
 * (`claude-sonnet-4-6`). Anything else, such as `opusplan`, `inherit`, `my-sonnet-fork` or a family not ranked here,
 * has no tier and so never takes part.
 */
export function tierOf(model: string): number | undefined {
  const family = /^(?:claude-)?(haiku|sonnet|opus)(?:-|\[|$)/.exec(String(model).toLowerCase())?.[1]
  return family === 'haiku' ? 1 : family === 'sonnet' ? 2 : family === 'opus' ? 3 : undefined
}

export type ModelFitInput = {
  /** Only roles with a floor in `FIT_FLOORS` can be tiered down; any other role, the architect and QA included, never is. */
  role: string
  /** The cheapest model the role may run on; never lower than the role's own floor in `FIT_FLOORS`, whichever is higher counts. */
  floor: string
  /** What the role runs on by default; a suggestion is always strictly below it. */
  default: string
  /** Model per difficulty level (index = level); may be shorter than the score range, then the last entry applies. */
  table: readonly string[]
  /** Deterministic floors passed: no failed attempt named, no migrations, auth, payments, concurrency or review work, no `risk` task. */
  floorsPassed: boolean
  /** The judgment came from the model the thresholds were calibrated on (`!result.uncalibrated`). */
  calibrated: boolean
  thresholds?: Thresholds
}
export type ModelFit = { suggest?: string; why: string[] }

/**
 * Suggests a cheaper model than the default, or nothing. Down only: `max(floor, min(default, table[level]))`, and
 * only for a role on the `FIT_FLOORS` allowlist, from the calibrated model, when the code floors passed, the work
 * reads as read-only or mechanical (level <= 1), the score is confident, the brief is specified and nothing
 * sensitive or evaluator-addressed shows. Anything uncertain or missing keeps the default.
 */
export function modelFit(answers: Answers, input: ModelFitInput): ModelFit {
  const t = input.thresholds ?? THRESHOLDS
  const none = (reason: string): ModelFit => ({ why: [reason] })
  if (!Object.hasOwn(FIT_FLOORS, input.role)) return none(`${input.role} is not on the tier-down allowlist`)
  if (!input.calibrated) return none('the answering model is not the calibrated one')
  if (!input.floorsPassed) return none('a code floor did not pass')

  // The floor is the higher of the caller's and the role's own (`FIT_FLOORS`): a caller cannot lower what the code set.
  const roleFloor = FIT_FLOORS[input.role]!
  const givenTier = tierOf(input.floor)
  const roleTier = tierOf(roleFloor)
  const top = tierOf(input.default)
  if (givenTier === undefined || roleTier === undefined || top === undefined) return none('floor or default has no known tier')
  const floor = Math.max(givenTier, roleTier)
  const floorModel = roleTier > givenTier ? roleFloor : input.floor
  if (floor >= top) return none('default is not above the floor')

  const difficulty = answers.difficulty
  const score = difficulty?.score
  if (typeof score !== 'number' || !Number.isFinite(score)) return none('no difficulty score')
  const level = Math.max(0, Math.min(Math.floor(score + 0.5), 4))
  if (level > t.fitMaxLevel) return none(`level ${level} > ${t.fitMaxLevel}`)
  const confidence = difficulty?.confidence
  if (typeof confidence !== 'number' || !(confidence >= t.fitConfidenceAtLeast)) return none(`difficulty confidence below ${show(t.fitConfidenceAtLeast)}`)
  const underspecified = noul(answers, 'underspecified')
  if (underspecified === undefined || !(underspecified < t.fitUnderspecifiedBelow)) return none(`underspecified not below ${show(t.fitUnderspecifiedBelow)}`)
  const sensitive = noul(answers, 'sensitive_area')
  const addressed = noul(answers, ADDRESSED_TO_JUDGE)
  if (sensitive === undefined || addressed === undefined || !(Math.max(sensitive, addressed) < t.fitSensitiveBelow)) {
    return none(`sensitive_area or ${ADDRESSED_TO_JUDGE} not below ${show(t.fitSensitiveBelow)}`)
  }

  const entry = input.table[Math.min(level, input.table.length - 1)]
  const wanted = entry === undefined ? undefined : tierOf(entry)
  if (entry === undefined || wanted === undefined) return none('table has no known model for this level')
  // max(floor, min(default, wanted)), spelled in tiers
  const target = Math.max(floor, Math.min(top, wanted))
  if (target >= top) return none(`level ${level} keeps the default`)
  const suggest = wanted >= floor ? entry : floorModel
  return { suggest, why: [`level ${level} (score ${show(score)}, confidence ${show(confidence)}): ${suggest} instead of ${input.default}`] }
}
