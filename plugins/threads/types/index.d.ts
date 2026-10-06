// The inputs of the tools this plugin registers in session.start, in the shape the engine lays for
// connected MCP tools, so `{ tool: 'mcp__threads__threads_start' }` matchers type `e`.
// Keep them in step with the inputSchema in hooks/register.tsx.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    mcp__threads__threads_start: { task: string; title?: string; model?: string; effort?: string }
    mcp__threads__threads_status: { id?: string }
    mcp__threads__threads_answer: { id: string; keys?: string[]; text?: string }
    mcp__threads__threads_close: { id: string }
  }
}
