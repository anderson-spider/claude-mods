// The card's session state under `session-hud`: what the hooks observed, prepared for drawing. Self-contained.

/** One rate-limit window as the host reports it: `five_hour`, `seven_day` or a gateway's `spend_limit`. */
export type SessionHudLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** One main-session turn's context: the prompt its first request sent, what the next request re-sends (the last prompt plus its output), the tokens it generated, and whether a compaction came before or during it. */
export type SessionHudTurn = { before: number; after: number; output: number; compacted?: true }

/** A subagent or teammate running now: its id (`agent.spawn`'s `agentId`) and, once reported, the model it runs on, the effort its last step asked for and the agent type it was spawned as. */
export type SessionHudAgent = { id: string; model?: string; effort?: string; type?: string }

/** Where the session works, by name only: the repository (or the folder outside one), the folder within it, the branch and whether it is a linked worktree. */
export type SessionHudWorkspace = { repo: string; sub?: string; branch?: string; worktree?: true }

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
  /** How long the prompt cache keeps an entry, as the host last reported it (only a model switch reports it); the render falls back to the `cacheTtl` option. */
  cacheTtl?: '5m' | '1h'
  /** Main-session turns completed since the plugin loaded. */
  turns: number
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
  /** The tokens every subagent and teammate request processed since the plugin loaded (input, cache read and written, output); absent before one reported usage. */
  agentTokens?: number
  /** Where the session works, as git last answered for its directory; absent before the first reading. */
  workspace?: SessionHudWorkspace
}

/** One next step: the label its checkbox shows and the prompt it puts in the prompt box, both cleaned. */
export type SessionHudStep = { label: string; prompt: string }

/** The next steps under the card: none, a fork asked after the main turn `turnId`, or the steps it offered. */
export type SessionHudSteps =
  | { kind: 'hidden' }
  | { kind: 'loading'; turnId: string }
  | { kind: 'offer'; steps: SessionHudStep[] }

/** Tokens as the host reports a request's usage: input, output, and cache read and written. */
export type SessionHudUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** A subagent or teammate the session panel lists, from its spawn on: how it runs, what it used and did, and how it ended. */
export type SessionHudPanelAgent = {
  id: string
  /** The agent type it was spawned as. */
  type?: string
  /** The model the host reported for its last request. */
  model?: string
  /** The effort its last request ran at. */
  effort?: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  endedAt?: number
  usage: SessionHudUsage
  requests: number
  /** The prompt its last request sent: input, cache read and written. */
  contextTokens?: number
  /** Its tool calls: the last few tools by name, how many calls and how many came back as errors. */
  activity?: { tools: string[]; calls: number; errors: number }
  /** Why a failed agent ended (`max_tokens`, `error`...). */
  endReason?: string
}

/** The main session as the panel adds to the card: the tokens its requests used and its turns of the last 15 minutes, as [start, end]. */
export type SessionHudPanelMain = { usage: SessionHudUsage; turns: [number, number][] }

/** What the session panel shows beyond the card: every agent the session spawned and the main session's usage and turns. */
export type SessionHudPanel = { agents: SessionHudPanelAgent[]; main: SessionHudPanelMain }

declare module 'claude-code' {
  interface PluginState {
    'session-hud': {
      /** The next steps, when the `nextSteps` option is on. */
      steps: SessionHudSteps
      card: SessionHudCard
      /** The clock reading, in epoch milliseconds, the time left and the pace are drawn from. */
      now: number
      /** The card's colours: `mockup` (the design's fixed colours) under a dark or automatic theme, `theme` (theme keys) under any other. */
      palette: 'mockup' | 'theme'
      /** The session panel's agents and main-session figures, kept in the store under the session so a resume brings them back. */
      panel: SessionHudPanel
      /** The clock reading the panel draws durations from: every second while an agent or a main turn runs. */
      panelNow: number
    }
  }
}
