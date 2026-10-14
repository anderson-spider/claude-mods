// The input of the tool this plugin registers in session.start, in the shape the engine lays for connected MCP tools
// (.claude-plugin/types/claude-code-mcp). Keep it in step with the inputSchema in hooks/register.tsx.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__codex-team__finish': { agent: string }
    'mcp__codex-team__dispatch': {
      role: 'developer' | 'analyst' | 'architect' | 'reviewer'
      task?: string
      slug: string
      cwd?: string
      effort?: 'low' | 'medium' | 'high' | 'xhigh'
    }
  }
}
