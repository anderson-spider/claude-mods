// The state spider-progress keeps under `spider-progress`, and the inputs of the two tools it registers in
// session.start, in the shape the engine lays for connected MCP tools. Keep the inputs in step with the inputSchema in
// hooks/register.tsx. `tasks` and `task` are objects, which SchemaFor does not type, so they are `unknown` here and
// checked in hooks/state.ts.

export type SpiderPhase = 'understand' | 'plan' | 'investigate' | 'execute' | 'review' | 'verify' | 'complete' | 'cancelled' | 'failed'
/** A task's stored state; `blocked` is derived from its dependencies, never stored. */
export type SpiderTaskState = 'pending' | 'running' | 'reviewing' | 'completed' | 'failed' | 'cancelled'
/** A spider-team agent role (the identifier keeps its old name). */
export type SpiderTier = 'planner' | 'worker' | 'researcher' | 'reviewer'
export type SpiderOwner = 'main' | SpiderTier

export type SpiderTask = {
  id: string
  title: string
  owner: SpiderOwner
  after: string[]
  state: SpiderTaskState
  criteria?: string
  /** 1 for the first try; each return from review adds one. */
  attempts: number
  evidence?: string
  errors: string[]
  agentIds: string[]
  /** Cancelled because the run was cancelled while it was open, so it still counts in the plan. */
  cancelledWithRun?: true
}

export type SpiderRun = { runId: string; title: string; phase: SpiderPhase; startedAt: number; finishedAt?: number; tasks: SpiderTask[] }

export type SpiderUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type SpiderAgent = {
  agentId: string
  type?: string
  tier?: SpiderTier
  taskId?: string
  /** The model the host reported for its last request. */
  model?: string
  /** The effort its last request ran at. */
  effort?: string
  /** The role's default effort, the one spider-team asks for. */
  plannedEffort?: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  endedAt?: number
  lastUpdate: number
  usage: SpiderUsage
  requests: number
  /** Estimated; absent while no request had a priced model. */
  costUsd?: number
  /** Some request ran on a model with no price, so `costUsd` covers only part of the usage. */
  costPartial?: true
  contextTokens?: number
  contextWindow?: number
  steps?: { done: number; total: number; note?: string }
}

export type SpiderMain = { model?: string; usage: SpiderUsage; costUsd?: number; costPartial?: true; contextTokens?: number; contextWindow?: number }

export type SpiderPanel = { open: boolean; compact: boolean; dismissedRunId?: string }

declare module 'claude-code' {
  interface PluginState {
    'spider-progress': {
      run: SpiderRun | null
      agents: SpiderAgent[]
      main: SpiderMain
      panel: SpiderPanel
      now: number
    }
  }
  interface McpToolInputs {
    'mcp__spider-progress__progress': {
      title?: string
      phase?: SpiderPhase
      tasks?: unknown
      task?: unknown
      finished?: boolean
      cancelled?: boolean
    }
    'mcp__spider-progress__step': {
      done: number
      total: number
      note?: string
    }
  }
}
