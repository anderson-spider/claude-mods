// Contrato do $.state do Pantheon (autocontido: sem imports).

export type JobStatus = 'running' | 'background' | 'done' | 'error' | 'cancelled' | 'lost'
export type Tokens = { input: number; cached: number; output: number }
export type Job = {
  id: string; agent: string; description?: string; model?: string; status: JobStatus
  startedAt: number; endedAt?: number; cwd: string; sessionId?: string
  lastActivity?: string; tokens?: Tokens; result?: string; error?: string
}

declare module 'claude-code' {
  interface PluginState {
    pantheon: { jobs: Job[] }
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
