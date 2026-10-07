/** One job as the band above the prompt draws it. */
export type BandJob = {
  /** The Herdr agent name `ct-<id>`, or the parent `loop-<id>`. */
  id: string
  kind: 'execute' | 'review' | 'loop'
  status: 'queued' | 'starting' | 'working' | 'blocked' | 'done' | 'failed' | 'cancelled' | 'developing' | 'reviewing' | 'approved' | 'exhausted'
  pane: string
  elapsedSeconds: number
  round?: number
  maxRounds?: number
}

declare module 'claude-code' {
  interface PluginState {
    'codex-team': { jobs: BandJob[] }
  }

  // The inputs of the tools this plugin registers in session.start, in the shape
  // the engine lays for connected MCP tools (.claude-plugin/types/claude-code-mcp),
  // so `{ tool: 'mcp__codex-team__execute' }` matchers type `e` before a save
  // regenerates that file. Keep them in step with the inputSchema in hooks/register.tsx.
  interface McpToolInputs {
    'mcp__codex-team__execute': {
      task: string
      files?: string[]
    }
    'mcp__codex-team__review': {
      target?: string
      focus?: string
    }
    'mcp__codex-team__loop': {
      task: string
      files?: string[]
      maxRounds?: number
    }
    'mcp__codex-team__jobs': {
      id?: number
      action?: 'cancel'
    }
  }
}
