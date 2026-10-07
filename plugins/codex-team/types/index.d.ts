// The inputs of the tools this plugin registers in session.start, in the shape
// the engine lays for connected MCP tools (.claude-plugin/types/claude-code-mcp),
// so `{ tool: 'mcp__codex-team__execute' }` matchers type `e` before a save
// regenerates that file. Keep them in step with the inputSchema in hooks/register.tsx.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__codex-team__execute': {
      task: string
      files?: string[]
    }
    'mcp__codex-team__review': {
      target?: string
      focus?: string
    }
    'mcp__codex-team__jobs': {
      id?: number
      action?: 'cancel'
    }
  }
}
