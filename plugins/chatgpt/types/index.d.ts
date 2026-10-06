// The inputs of the tools this plugin registers in session.start, in the shape
// the engine lays for connected MCP tools (.claude-plugin/types/claude-code-mcp),
// so `{ tool: 'mcp__chatgpt__ask' }` matchers type `e` before a save regenerates
// that file. Keep them in step with the inputSchema in hooks/register.tsx.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    mcp__chatgpt__ask: {
      prompt: string
      chatUrl?: string
      model?: string
      files?: string[]
      wait?: boolean
      saveOnly?: boolean
      out?: string
      maxChars?: number
    }
    mcp__chatgpt__image: {
      prompt: string
      reference?: string
      chatUrl?: string
      model?: string
      files?: string[]
      wait?: boolean
      saveOnly?: boolean
      out?: string
    }
    mcp__chatgpt__jobs: {}
  }
}
