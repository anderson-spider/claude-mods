declare module 'claude-code' {
  // The inputs of the tools this plugin registers in session.start, in the shape
  // the engine lays for connected MCP tools (.claude-plugin/types/claude-code-mcp),
  // so `{ tool: 'mcp__tailscale__tailscale_get' }` matchers type `e` before a save
  // regenerates that file. Keep them in step with the inputSchema in hooks/register.tsx.
  interface McpToolInputs {
    'mcp__tailscale__tailscale_get': {
      path: string
      fields?: string[]
    }
    'mcp__tailscale__tailscale_write': {
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
      path: string
      body?: unknown
      ifMatch?: string
    }
  }
}
