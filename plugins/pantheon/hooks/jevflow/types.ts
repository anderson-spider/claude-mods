// Shared shapes of the JevFlow port. Keys keep JevFlow's snake_case: flow.json and state.json on disk are JevFlow's.
// Ported without: `mode` (always enforce), `gates`, `notify`, `dynamic` phases and sub-steps.

export type Loop = { max_iterations: number; until: string }

export type Phase = {
  id: string
  name: string
  done_when: string
  check?: string
  depends_on: string[]
  loop?: Loop
  on_fail?: string
  side_effect: boolean
}

export type Confidence = { auto: number; review: number; flag: number; trust_check: number }

export type Limits = {
  max_blocks_per_session: number
  max_restarts: number
  max_total_minutes: number
  hang_minutes: number
  max_jev_calls: number
  check_timeout_s: number
  state_char_budget: number
  confidence: Confidence
}

export type Flow = {
  goal: string
  title: string
  schema_version: 1
  flow_version: string
  phases: Phase[]
  limits: Limits
  privacy: { send_diff: boolean }
}

export type PhaseStatus = 'pending' | 'active' | 'done'

/** Pantheon's roles, the only values a claim's `as` takes. */
export const ROLES = ['lead', 'code-reader', 'docs-reader', 'developer', 'ux', 'architect', 'qa'] as const
export type Role = (typeof ROLES)[number]

/**
 * One agent seen in this flow (JevFlow agents.py), keyed `session:<id>` or `agent:<id>`. `phase` is its claim while `claimed`,
 * else the flow's current phase; `role` is the Pantheon role it claimed as.
 */
export type AgentEntry = {
  label: string
  kind: 'session' | 'subagent'
  type?: string
  session: string
  phase?: string
  claimed?: boolean
  role?: Role
  first_at: number
  at: number
  tools: number
  stops: number
}

/** A journal entry (state.py `record`): `event` names it; a Stop's adds decision, condition, reason and the rest. */
export type HistoryEntry = {
  ts: number
  seq: number
  event: string
  phase?: string | null
  decision?: string
  condition?: string
  reason?: string
  to_phase?: string | null
  [key: string]: unknown
}

export type ErrorNote = { error: string; ts: number; source?: string; details?: string; session_id?: string | null }

/** state.json, as JevFlow state.py writes it (sub-step fields dropped). */
export type FlowState = {
  state_schema: number
  flow_version: string
  current_phase: string
  phase_status: Record<string, PhaseStatus>
  blocks_this_session: number
  restarts: number
  jev_calls: number
  loop_iterations: Record<string, number>
  phase_attempts: Record<string, number>
  consecutive_blocks: number
  stuck_streak: number
  escalations: number
  same_reason_count: number
  needs_human: string | null
  last_failure: string | null
  review_streak: { phase: string; n: number } | null
  last_block_reason: string | null
  /** The last Claude API error (StopFailure). */
  last_error: ErrorNote | null
  /** The last failed Jev call (that Stop was held once and then let through). */
  last_jev_error?: ErrorNote
  started_at: number
  updated_at: number
  seq?: number
  session_id?: string | null
  history: HistoryEntry[]
  done: boolean
  agents: Record<string, AgentEntry>
}

/** A deterministic check's outcome; `passed: null` means not run or no check. */
export type CheckResult = { passed: boolean | null; output: string }

export const UNCLEAR = 'unclear'

export type Judgment = {
  current_phase: string
  current_phase_conf: number
  current_phase_probs: Record<string, number>
  next_action: string
  next_action_conf: number
  phase_done: Record<string, number>
  verify_phase: string | null
  verify: number | null
  stuck: number
  off_goal: number
  claims_done: number
}

export const ALLOW_STOP = 'ALLOW_STOP'
export const BLOCK = 'BLOCK'
export const ADVANCE = 'ADVANCE'
export type DecisionKind = typeof ALLOW_STOP | typeof BLOCK | typeof ADVANCE

export type Decision = {
  kind: DecisionKind
  condition: string
  reason: string
  to_phase?: string
  notes: string[]
  /** Fields to set on the state, applied by `applyDecision`; `blocks_inc` is charged to the block count then. */
  patch: Partial<FlowState> & { blocks_inc?: number }
  /** Set when the decision asks a human. */
  question?: string
}
