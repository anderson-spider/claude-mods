// Contrato do $.state do Pantheon (autocontido: sem imports).

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
export type PanelGroup = 'running' | 'idle'
export type PanelTab = 'agents' | 'flow'
export type PanelView = { collapsed?: PanelGroup[]; tab?: PanelTab }
declare module 'claude-code' {
  /**
   * The input of the flow tool registered in session.start, in the shape the engine lays for connected MCP tools, so the
   * `{ tool: 'mcp__pantheon__flow' }` matcher types `e`. Keep it in step with the inputSchema in hooks/register.tsx.
   */
  interface McpToolInputs {
    mcp__pantheon__flow: {
      action: 'start' | 'validate' | 'join' | 'claim' | 'status'
      goal?: string
      name?: string
      flow?: string
      phase?: string
      as?: 'lead' | 'code-reader' | 'docs-reader' | 'developer' | 'ux' | 'architect' | 'qa'
    }
  }
  interface PluginState {
    pantheon: { natives: Native[]; session: SessionInfo; view: PanelView; gateHeld: { message: string } | null }
  }
}
