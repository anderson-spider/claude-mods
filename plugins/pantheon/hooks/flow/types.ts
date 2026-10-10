// The flow controller's shared contract: state, the events it decides on and the decision it returns.
// Pure types; plan.ts owns the flow block, policy.ts the decisions, store.ts the files.

import type { TaskStatus } from './plan'

export type Mode = 'off' | 'shadow' | 'enforce'

/** One check of a task: `passed` is null when it could not run (missing binary, timeout), with why in `output`. */
export type CheckResult = { argv: string[]; passed: boolean | null; output: string }

/** What a judge said about a checkpoint. Recorded for calibration only: the policy never acts on it. */
export type Judgment = {
  source: 'jev'
  scores: Partial<Record<'claimsDone' | 'complete' | 'stuck', number>>
} | { source: 'none'; reason: string }

export type FlowState = {
  planId: string
  /** The flow block's hash when this state was created; a different hash means the plan changed. */
  hash: string
  /** The hash the person approved with `/pantheon flow approve`; unset until then. */
  approvedHash?: string
  status: Record<string, TaskStatus>
  /** Failed attempts per task since it last became active. */
  attempts: Record<string, number>
  /** Tasks with an oracle review receipt. */
  reviewed: string[]
  /** Risk tasks whose checks passed and that wait for the oracle's verdict before they count as done. */
  awaitingReview: string[]
  /** Side-effect tasks recorded done in the ledger; never re-entered. */
  sideEffectsDone: string[]
  /** Blocks spent since the person last wrote; refilled on every human prompt. */
  blocks: number
  /** Consecutive Stop blocks (the engine honors 8); reset when a Stop is allowed. */
  consecutiveBlocks: number
  /** The last failing output, and how many times in a row it repeated. */
  lastFailure?: { key: string; count: number }
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
  /** The main session tries to stop. `checks` holds the active task's and every done task's results (regression). */
  | { kind: 'stop'; stopHookActive: boolean; backgroundTasks: number; runningAgents: number; checks: Record<string, CheckResult[]> }
  /** The person wrote: the block budget refills. */
  | { kind: 'humanPrompt' }
  /** The oracle reviewed a task that was awaiting review. */
  | { kind: 'review'; taskId: string; verdict: 'approved' | 'rejected'; note?: string }

export type Action = 'allow' | 'block' | 'advance' | 'wait' | 'pause' | 'complete' | 'failTask'

export type Decision = {
  action: Action
  /** A stable tag naming the rule that fired, for the journal and calibration. */
  condition: string
  /** What the agent or the orchestrator reads: a concrete next step, with failing output when there is any. */
  reason: string
  /** The state after this decision; the caller saves it. */
  state: FlowState
  /** The task the decision moves to, when it moves. */
  task?: string
}
