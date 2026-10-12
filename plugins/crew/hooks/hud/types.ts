// The HUD's atom value types. Plain data only (JSON-safe, no host types), so the atoms can hold them and the pure
// modules can take them in tests. Reducers live in state.ts; views over them in plan.ts, quota-view.ts and timeline.ts.
import type { Provider } from '../quota'
import type { ParsedPlan } from './plan'

export type { Provider }

export type Tokens = {
  /** input + cache reads + cache writes */
  input: number
  /** cache reads alone (the "cached" share is `cacheRead / input`) */
  cacheRead: number
  output: number
}

export const NO_TOKENS: Tokens = { input: 0, cacheRead: 0, output: 0 }

/** A step's usage as the API reported it; every field may be missing. */
export type StepUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** How a turn ended: `answer`, `aborted` (stopped), `refusal` or `error` (failed). */
export type EndReason = 'answer' | 'aborted' | 'refusal' | 'error' | (string & {})

/** The outcome of a round. */
export type RoundStatus = 'running' | 'done' | 'failed' | 'stopped'

export type Round = {
  startedAt: number
  endedAt?: number
  status: RoundStatus
  /** Why a failed round failed: `max_tokens`, `refusal` or `error`. */
  failure?: string
}

/** What the main loop's last turn (or the current one) came to. */
export type Receipt = {
  /** `done`, `stopped` or `failed` (the glyph `✓`, `■`, `✗`). */
  outcome: Exclude<RoundStatus, 'running'>
  /** How the turn ended, as the host said. */
  reason: EndReason
  durationMs: number
  /** Cost of the turn, or null when no ledger. */
  costUsd: number | null
  input: number
  output: number
  /** Subagents spawned during the turn. */
  agents: number
}

/** A turn in progress. */
export type TurnNow = {
  startedAt: number
  costAtStart: number | null
  input: number
  output: number
  agents: number
}

export type Ask = { id: string; who: string; tool: string }

/** The `session` atom. */
export type Session = {
  model: string
  /** '' when the host sends none. */
  effort: string
  /** The permission mode (`default`, `auto`, `plan`, ...), '' until known. */
  mode: string
  isWorking: boolean
  /** Context fill 0-100, tokens and window; null before the first measurement. */
  contextPct: number | null
  contextTokens: number | null
  contextWindow: number
  costUsd: number | null
  /** Summed over every step of the session, main loop and agents. */
  tokens: Tokens
  startedAt: number
  compactions: number
  turn: TurnNow | null
  /** The main loop's finished turns, newest last (50 at most): the lead's lane. */
  turns: { startedAt: number; endedAt: number }[]
  lastTurn: Receipt | null
  /** Permission asks waiting on the person. */
  asks: Ask[]
}

/** One agent (a subagent card): the id is the host's agent id. */
export type AgentCard = {
  id: string
  /** The final type, `-codex` included. */
  type: string
  provider: Provider
  /** The description as the lead wrote it, without Jev's tag. */
  description: string
  /** The plan step id the description starts with, or null. */
  stepId: string | null
  /** Model id as the API reported it; the planned one until the first step. */
  model: string
  /** '' when none was sent. */
  effort: string
  spawnedAt: number
  /** Oldest first. */
  rounds: Round[]
  steps: number
  /** Tokens in the agent's last request (its context), 0 before the first step. */
  ctx: number
  output: number
  /** The stop reason of the last step (`max_tokens` names a failure). */
  lastStop: string | null
  /** The last tool and its target (`Edit internal/config/contract_on.go`). */
  lastTool: string
  /** A refused call (`Bash git push`), shown in red until the next tool. */
  denied: string
}

/** One consult of the architect (or the server advisor tool). */
export type Consult = {
  id: string
  /** `architect`, `architect·cx` or `advisor`. */
  who: string
  at: number
  endAt: number | null
  description: string
  stepId: string | null
  /** The answer's first non-empty line, Markdown marks stripped (160 cells at most), '' while consulting. */
  line: string
  verdict: Verdict | null
  /** The rest of the line after the verdict word. */
  reason: string
}

export type Verdict = 'Approve' | 'Fixes' | 'Reject'

export type LogKind = 'prompt' | 'spawn' | 'done' | 'failed' | 'stopped' | 'deny' | 'consult' | 'verdict' | 'compact' | 'plan'

export type LogLine = {
  at: number
  /** `you`, `lead`, `plan` or an agent's display name. */
  who: string
  kind: LogKind
  text: string
  /** The agent type the line is about, when it is one (for the role color). */
  type?: string
}

/** A workflow agent or fork: stepping without a card. */
export type Loop = { id: string; firstAt: number; lastAt: number; steps: number; isDone: boolean }

/**
 * Which provider was favored last and since when. `isChange` is false for the first observation, so a session's first
 * reading does not count as a change (the 10-minute rule of the mini quota line).
 */
export type Favored = { provider: Provider; since: number; isChange: boolean }

/** The active plan: its file, what was read from it (null when it could not be read) and why it is the one shown. */
export type HudPlan = {
  /** Absolute path of `.crew/plans/<name>.md`. */
  path: string
  name: string
  parsed: ParsedPlan | null
  /** The file's mtime when it was read; 0 when it could not be. */
  mtimeMs: number
  /** Pinned with `/crew:panel plan <name>`, the last written this session, or the newest unfinished at the start. */
  why: 'pin' | 'written' | 'recent'
}

/** How the side pane is drawn and what the session chose for the HUD. */
export type HudView = {
  /** `/crew:panel layout`: full when docked (`auto`) or the summary always (`mini`). */
  layout: 'auto' | 'mini'
  /** The agent whose details are open in the focused pane. */
  openId: string | null
  /** The plan `/crew:panel plan <name>` pinned (its name), or null to follow the plan last written. */
  pin: string | null
  /** The plan file last written or edited this session (absolute path). */
  lastWritten: string | null
  /** The host has reported Claude's limits (or a turn's measurement) at least once this session. */
  claudeMeasured: boolean
}

export const DEFAULT_VIEW: HudView = { layout: 'auto', openId: null, pin: null, lastWritten: null, claudeMeasured: false }

/** The value types of the HUD's atoms, by atom name. */
export type HudAtoms = {
  session: Session
  agents: AgentCard[]
  consults: Consult[]
  log: LogLine[]
  loops: Loop[]
  favored: Favored | null
  plan: HudPlan | null
  view: HudView
}
