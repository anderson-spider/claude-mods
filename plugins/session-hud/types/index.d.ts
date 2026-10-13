// The card's session state under `session-hud`: what the hooks observed, prepared for drawing. Self-contained.

/** One rate-limit window as the host reports it: `five_hour`, `seven_day` or a gateway's `spend_limit`. */
export type SessionHudLimit = { kind: string; percentUsed: number; resetsAt?: string }

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
  /** US dollars the session has cost so far. */
  cost?: number
  limits: SessionHudLimit[]
  /** When the running main-session turn began, in epoch milliseconds; absent between turns. */
  turnStartedAt?: number
  /** How long the main session's last turn took, in milliseconds. */
  lastTurnMs?: number
  /** What the session cost between the measurements around the last turn, in US dollars. */
  lastTurnCost?: number
  /** Successful Write, Edit and NotebookEdit calls of the main session. */
  edits: number
  /** Tool calls of the main session that ended in an error. */
  errors: number
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
