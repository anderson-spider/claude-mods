// The card's session state under `session-hud`: what the hooks observed, prepared for drawing. Self-contained.

/** One rate-limit window as the host reports it: `five_hour`, `seven_day` or a gateway's `spend_limit`. */
export type SessionHudLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** One main-session turn's context: the prompt its first request sent, what the next request re-sends (the last prompt plus its output), the tokens it generated, and whether a compaction came before or during it. */
export type SessionHudTurn = { before: number; after: number; output: number; compacted?: true }

/** A subagent or teammate running now: its id (`agent.spawn`'s `agentId`) and, once reported, the model it runs on. */
export type SessionHudAgent = { id: string; model?: string }

/** Everything the card draws, observed after the fact; a field the host has not reported yet is absent. */
export type SessionHudCard = {
  /** The model id the main session's last response reported, or the session's model before one. */
  model?: string
  /** The effort the main session's last request asked for. */
  effort?: string
  /** The context window's fill: tokens of the last response's input against the window. */
  context?: { tokens?: number; window: number; percent?: number }
  /** The window the host measures and compacts against: the model's limit or a smaller `autoCompactWindow`. */
  contextWindow?: number
  /** The share of the main session's last input read from the prompt cache, 0 to 100. */
  cache?: number
  /** When a main-session request last read or wrote the prompt cache, in epoch milliseconds. */
  cacheUsedAt?: number
  /** How long the prompt cache keeps an entry, as the host last reported it (only a model switch reports it). */
  cacheTtl?: '5m' | '1h'
  /** Main-session turns completed since the plugin loaded. */
  turns: number
  /** Output tokens of the main session's steps since the plugin loaded. */
  output: number
  limits: SessionHudLimit[]
  /** When the running main-session turn began, in epoch milliseconds; absent between turns. */
  turnStartedAt?: number
  /** How long the main session's last turn took, in milliseconds. */
  lastTurnMs?: number
  /** The last finished main-session turns, oldest first, at most `HISTORY`. */
  history: SessionHudTurn[]
  /** The running main-session turn's context so far; absent between turns. */
  pending?: SessionHudTurn
  /** A compaction ran since the last turn joined the history: the next one to join is marked. */
  compacted?: true
  /** Successful Write, Edit and NotebookEdit calls of the main session. */
  edits: number
  /** Tool calls of the main session that ended in an error. */
  errors: number
  /** The subagents and teammates running a turn now, in the order they were seen; empty when none runs. */
  agents: SessionHudAgent[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-hud': {
      card: SessionHudCard
      /** The clock reading, in epoch milliseconds, the time left and the pace are drawn from. */
      now: number
      /** The card's colours: `mockup` (the design's fixed colours) under a dark or automatic theme, `theme` (theme keys) under any other. */
      palette: 'mockup' | 'theme'
    }
  }
}
