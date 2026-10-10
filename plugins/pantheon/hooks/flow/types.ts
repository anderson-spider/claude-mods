// The flow controller's shared contract: state, the events it decides on and the decision it returns.
// Pure types; plan.ts owns the flow block, policy.ts the decisions, store.ts the files.

import type { TaskStatus } from './plan'

export type Mode = 'off' | 'shadow' | 'enforce'

/** The newest ids and edit keys a state remembers. */
export const SEEN_IDS_MAX = 1000
export const SEEN_EDITS_MAX = 64
/** The failing output kept per task for the retry battery, and how many tasks keep one. */
export const LAST_OUTPUT_MAX = 1500
export const LAST_OUTPUT_TASKS_MAX = 100
/** `list` with `items` added (each once), keeping the newest `max`. */
export function remember(list: readonly string[] | undefined, items: readonly string[], max: number): string[] {
  const out = [...(list ?? [])]
  for (const item of items) if (!out.includes(item)) out.push(item)
  return out.length > max ? out.slice(out.length - max) : out
}

/**
 * One check of a task: `passed` is null when it could not run, with why in `output`. `couldNotRun` marks the ones that could
 * not run because of the environment the task left behind (a missing or non-directory `cwd`, a process that failed to
 * start): the policy treats those as unverified, not failed, so they cost no attempt and do not hold the Stop. A timeout or
 * a runner exit is a real failure and never carries it.
 */
export type CheckResult = { argv: string[]; passed: boolean | null; output: string; couldNotRun?: true }

/**
 * The first generation of the judge's seam, kept so `decide` keeps its signature: a judgment passed here is accepted and
 * ignored. The judge reaches the policy only as `DecideOptions` (a second `decide` that can only be stricter).
 */
export type Judgment = {
  source: 'jev'
  scores: Partial<Record<'claimsDone' | 'complete' | 'stuck', number>>
} | { source: 'none'; reason: string }

/** Who gives a receipt: the architect reviews risky work, QA verifies acceptance criteria. */
export type Reviewer = 'architect' | 'qa'
/** A task waiting for one receipt. */
export type Awaiting = { task: string; by: Reviewer }
export type Receipts = { architect?: true; qa?: true }

/** What `decide` may be told about the world; both are optional and only ever make the flow stricter or ask the person. */
export type DecideOptions = {
  /**
   * Every task that is not a side effect needs a QA receipt (decision 18: the judge doubts a "complete" claim). The task
   * is then recorded in `FlowState.qaRequired`, so the requirement outlives this call. On a side-effect task it does
   * nothing and the decision carries `note: 'require_qa_ignored'`.
   */
  requireQa?: boolean
  /**
   * A failing check whose retry the judge doubts (decision 18): the task goes to the architect's diagnosis now instead of
   * burning another attempt. `attempts` is set to the limit (never lowered), so the ladder continues as it would after the
   * last attempt: one more try after the diagnosis, then the person. It never advances, never marks a task done, never
   * overrides ownership, the limit or a pause, and is ignored (`note: 'retry_to_architect_ignored'`) when the architect is
   * disabled or the task has an `onFail` branch still to run: the judge cannot pause a flow or move it to another task.
   */
  retryToArchitect?: boolean
  /** Whether each role is enabled. A role that is disabled while a task needs its receipt (or the architect's diagnosis) pauses the flow and asks the person. */
  available: { qa: boolean; architect: boolean }
}

export type FlowState = {
  planId: string
  /**
   * The hash of the flow this state's progress is for: the effective flow, that is the approved snapshot plus the
   * amendments adopted on top of it (`approved.json`). It is not the plan file's hash: the file may say more.
   */
  hash: string
  /** The hash the person approved with `/pantheon flow approve`; unset until then. An adoption never moves it. */
  approvedHash?: string
  /** The effective flow's hash once amendments were adopted over the approved snapshot; unset while they are one and the same. */
  adoptedHash?: string
  /**
   * The plan-file edits already journaled as waiting for approval or as invalid (each its hash, or a key for a file that did
   * not validate; the newest SEEN_EDITS_MAX), so that one edit is journaled once however many events see it or in what
   * order two of them alternate. An approval or an adoption starts the set over.
   */
  seenEdits?: string[]
  /**
   * Every task id this plan has had (the newest SEEN_IDS_MAX): an adopted amendment never reuses one. Kept here, not read
   * back from the journal, whose cap would forget them.
   */
  seenIds?: string[]
  status: Record<string, TaskStatus>
  /** Failed attempts per task since it last became active. */
  attempts: Record<string, number>
  /**
   * Receipts still to come: a task whose checks passed (or whose attempt was otherwise accepted) that waits for the
   * architect's review or for QA's verdict before it counts as done. A task may wait for both, in any order.
   */
  awaiting: Awaiting[]
  /**
   * Receipts earned per task: `architect` is an approved review, `qa` a passing verdict. A task is done only when its
   * checks pass AND every receipt it requires exists (see `requiredReceipts` in policy.ts). A failed attempt, a
   * regression and a failing check clear the task's receipts.
   */
  receipts: Record<string, Receipts>
  /** Tasks that a `requireQa` escalation made wait for QA; the requirement stays until the task is done. */
  qaRequired: string[]
  /**
   * Task ends seen per task (every acted-on `taskEnd` counts, passing or not). A reviewer is spawned for one end and
   * its `review` event carries that count: a verdict about older code is ignored.
   */
  ends: Record<string, number>
  /** Side-effect tasks recorded done in the ledger; never re-entered. */
  sideEffectsDone: string[]
  /** Blocks spent since the person last wrote; refilled on every human prompt. */
  blocks: number
  /** Consecutive Stop blocks (the engine honors 8); reset when a Stop is allowed. */
  consecutiveBlocks: number
  /** The last failing output, and how many times in a row it repeated. */
  lastFailure?: { key: string; count: number }
  /**
   * The output of the failing check of a task's last failed delivery (redacted of secrets, at most `LAST_OUTPUT_MAX`
   * characters), kept only while the judge is on: it is the "previous output" the retry battery compares with. Dropped when
   * the task is done, delivers a pass, or the attempts start over.
   */
  lastOutput?: Record<string, string>
  paused: boolean
  stopped: boolean
  done: boolean
  /** The last instruction the controller gave, re-injected on the next human prompt. */
  lastInstruction?: string
  /** The mode the flow last ran in, so a switch into enforce can be told from a reload. */
  mode?: Mode
}

export type FlowEvent =
  /** A delegated task's agent returned. `ownershipDenials` counts writes the controller refused. */
  | { kind: 'taskEnd'; taskId: string; checks: CheckResult[]; ownershipDenials: number }
  /** The main session tries to stop. `checks` holds the results of every active task, every task awaiting a receipt (a failing check there drops its wait) and every done task (regression). */
  | { kind: 'stop'; stopHookActive: boolean; backgroundTasks: number; runningAgents: number; checks: Record<string, CheckResult[]> }
  /** The person wrote: the block budget refills. */
  | { kind: 'humanPrompt' }
  /**
   * The architect or QA returned for a task that was awaiting them: `pass` earns the receipt, `fail` is a failed
   * attempt. QA may also say `blocked` (it could not run the task's environment): that pauses and asks the person
   * without spending an attempt. `end` is the task's end count when the reviewer was spawned (`FlowState.ends`); a
   * review for a task not awaiting that `by`, or carrying another `end`, is ignored.
   */
  | { kind: 'review'; taskId: string; end: number; note?: string } & (
    | { by: 'architect'; verdict: 'pass' | 'fail' }
    | { by: 'qa'; verdict: 'pass' | 'fail' | 'blocked' }
  )

export type Action = 'allow' | 'block' | 'advance' | 'wait' | 'pause' | 'complete' | 'failTask'

export type Decision = {
  action: Action
  /** A stable tag naming the rule that fired, for the journal and calibration. */
  condition: string
  /** What the agent or the lead reads: a concrete next step, with failing output when there is any. */
  reason: string
  /** The state after this decision; the caller saves it. */
  state: FlowState
  /** The task the decision moves to, when it moves. */
  task?: string
  /** A tag for something the policy ignored on purpose, so the caller can journal it (`require_qa_ignored`). */
  note?: string
}
