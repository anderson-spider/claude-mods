// The crew's state under `crew`: the HUD's atoms and the quota the router keeps. The contract is self-contained, so these
// mirror the value types in `hooks/hud/types.ts`, `hooks/hud/plan.ts` and `hooks/quota.ts`; `hooks/hud/register.tsx`
// reads and writes them through those types, so tsc holds the two in step.

/** Where the panel shows: the host's pane beside (or inline above) the prompt, or the plugin's own band above the prompt. */
export type Placement = 'side' | 'prompt'

/** The person's pick for the session: whether the panel is shown and where. */
export type PanelChoice = { isVisible: boolean; placement: Placement }

/** Tokens summed over steps: input (cache reads and writes included), cache reads alone, output. */
export type HudTokens = { input: number; cacheRead: number; output: number }

/** How a turn ended, as the host said. */
export type HudEndReason = 'answer' | 'aborted' | 'refusal' | 'error' | (string & {})

export type HudRoundStatus = 'running' | 'done' | 'failed' | 'stopped'

/** One job of an agent; a resumed agent adds one. */
export type HudRound = { startedAt: number; endedAt?: number; status: HudRoundStatus; failure?: string }

/** What the main loop's last turn came to. */
export type HudReceipt = {
  outcome: Exclude<HudRoundStatus, 'running'>
  reason: HudEndReason
  durationMs: number
  costUsd: number | null
  input: number
  output: number
  agents: number
}

/** A permission ask waiting on the person. */
export type HudAsk = { id: string; who: string; tool: string }

/** The main loop and the session: model, context, cost, tokens, the turn now and the last one. */
export type HudSession = {
  model: string
  effort: string
  mode: string
  isWorking: boolean
  contextPct: number | null
  contextTokens: number | null
  contextWindow: number
  costUsd: number | null
  tokens: HudTokens
  startedAt: number
  compactions: number
  turn: { startedAt: number; costAtStart: number | null; input: number; output: number; agents: number } | null
  turns: { startedAt: number; endedAt: number }[]
  lastTurn: HudReceipt | null
  asks: HudAsk[]
}

/** One subagent: its final type (a `-codex` twin included), the description as the lead wrote it, its jobs. */
export type HudAgent = {
  id: string
  type: string
  provider: 'claude' | 'codex'
  description: string
  stepId: string | null
  model: string
  effort: string
  spawnedAt: number
  rounds: HudRound[]
  steps: number
  ctx: number
  output: number
  lastStop: string | null
  lastTool: string
  denied: string
}

/** One consult of the architect, its Codex twin or the server advisor tool, with the first line of its answer. */
export type HudConsult = {
  id: string
  who: string
  at: number
  endAt: number | null
  description: string
  stepId: string | null
  line: string
  verdict: 'Approve' | 'Fixes' | 'Reject' | null
  reason: string
}

export type HudLogKind = 'prompt' | 'spawn' | 'done' | 'failed' | 'stopped' | 'deny' | 'consult' | 'verdict' | 'compact' | 'plan'

export type HudLogLine = { at: number; who: string; kind: HudLogKind; text: string; type?: string }

/** A workflow agent or a fork: a loop that steps with no card. */
export type HudLoop = { id: string; firstAt: number; lastAt: number; steps: number; isDone: boolean }

/** The provider the router last favored and since when; the first reading is not a change. */
export type HudFavored = { provider: 'claude' | 'codex'; since: number; isChange: boolean }

export type HudStepState = 'queued' | 'implementing' | 'ready for QA' | 'fixes requested' | 'verified' | 'blocked' | 'committed'

/** One step line of a plan file. */
export type HudStep = { id: string; owner: string; after: string[]; text: string; state: HudStepState; note: string; line: number }

/** The active plan, read from `.crew/plans/<name>.md`; `parsed` is null when the file could not be read. */
export type HudPlan = {
  path: string
  name: string
  parsed: { steps: HudStep[]; waves: string[][]; skipped: number } | null
  mtimeMs: number
  why: 'pin' | 'written' | 'recent'
}

/** The side pane's layout, the open details, the pinned plan, the plan last written and whether Claude was measured. */
export type HudView = {
  layout: 'auto' | 'mini'
  openId: string | null
  pin: string | null
  lastWritten: string | null
  claudeMeasured: boolean
}

/** One rate-limit window: how much is used (0-100) and when it resets (ISO 8601). */
export type QuotaWindow = { percentUsed: number; resetsAt?: string }

/** What a provider reports; a window it does not report is absent. */
export type QuotaReading = { fiveHour?: QuotaWindow; sevenDay?: QuotaWindow }

/** Both providers' limits and the provider they favor, kept by the router and read by the HUD. */
export type QuotaState = {
  claude: QuotaReading | null
  codex: QuotaReading | null
  /** `ok` fresh; `unknown` none yet or none usable; `stale` too old; `down` the status request failed; `off` not asked. */
  codexState: 'ok' | 'unknown' | 'stale' | 'down' | 'off'
  /** When the Codex status was fetched (ms since epoch), or null before the first fetch. */
  fetchedAt: number | null
  /** When the Codex limits were observed (ms; the oldest window's), or null. */
  codexObservedAt: number | null
  /** When the last non-empty Claude reading was taken (ms), or null. */
  claudeAt: number | null
  /** The decision for these readings; `reason` has no provider prefix and fits 34 cells. */
  decision: { provider: 'claude' | 'codex'; reason: string }
}

declare module 'claude-code' {
  interface PluginState {
    'crew': {
      hudSession: HudSession
      hudAgents: HudAgent[]
      hudConsults: HudConsult[]
      hudLog: HudLogLine[]
      hudLoops: HudLoop[]
      hudFavored: HudFavored | null
      hudPlan: HudPlan | null
      hudView: HudView
      /** The session's panel choice; null until session.start seeded it. */
      panel: PanelChoice | null
      /** Claude's and Codex's limits and the provider they favor (`hooks/quota.ts`). */
      quota: QuotaState
    }
  }
}
