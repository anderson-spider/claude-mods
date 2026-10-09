// Contrato do $.state do Pantheon (autocontido: sem imports).

export type JobStatus = 'running' | 'background' | 'done' | 'error' | 'cancelled' | 'lost'
export type Tokens = { input: number; cached: number; output: number }
export type Job = {
  id: string; agent: string; description?: string; model?: string; status: JobStatus
  startedAt: number; endedAt?: number; cwd: string; sessionId?: string
  lastActivity?: string; tokens?: Tokens; result?: string; error?: string
}

export type RoundStatus = 'running' | 'done' | 'failed' | 'stopped' | 'lost'
export type Round = { turnId?: string; startedAt: number; endedAt?: number; status: RoundStatus }
export type Native = {
  id: string; role: string; type: string; task: string; model: string
  rounds: Round[]; ctx: number; out: number; steps: number; lastTool?: string
}
export type SessionInfo = {
  model?: string; effort?: string
  context?: { tokens: number | null; window: number; percent: number | null }
  isRunning: boolean; turnStartedAt?: number; lastTurnMs?: number
  turns?: { startedAt: number; endedAt: number }[]
  /** US dollars the session has cost so far, as the host's ledger totals it. */
  costUsd?: number
}
export type PanelGroup = 'running' | 'finished' | 'planned'
export type PanelView = { tab: 'agents' | 'jobs'; collapsed?: PanelGroup[] }

declare module 'claude-code' {
  interface PluginState {
    pantheon: { jobs: Job[]; natives: Native[]; session: SessionInfo; view: PanelView }
  }
  // The inputs of the tools registered in session.start, in the shape the engine lays for
  // connected MCP tools; keep them in step with the inputSchema in hooks/register.tsx.
  interface McpToolInputs {
    mcp__pantheon__delegate: {
      agent: string
      prompt: string
      description?: string
      cwd?: string
      model?: string
      effort?: string
      background?: boolean
      resume?: string
    }
    mcp__pantheon__delegate_result: { jobId: string }
    mcp__pantheon__delegate_cancel: { jobId: string }
  }
}
