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
  interface PluginState {
    pantheon: { natives: Native[]; session: SessionInfo; view: PanelView; gateHeld: { message: string } | null }
  }
}
