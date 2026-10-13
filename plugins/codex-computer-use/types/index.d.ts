/** An app-approval question waiting for the person, drawn above the prompt. */
export type CodexAsking = {
  id: string
  bundleId: string
  displayName: string
  /** Codex offers "always" for this app. */
  canAlways: boolean
  /** Who asked: `main session` or `subagent <id>`. */
  who: string
}

/**
 * The input of the tool this plugin registers in session.start, in the shape the
 * engine lays for connected MCP tools (.claude-plugin/types/claude-code-mcp), so
 * the literal `{ tool: 'mcp__codex-computer-use__codex_cu' }` matcher types `e`
 * before a save regenerates that file. hooks/prompts.ts checks its keys against
 * the `inputSchema` there.
 */
export type CodexCuInput = {
  code?: string
  title?: string
  timeout_ms?: number
  reset?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'codex-computer-use': { asking: CodexAsking | null }
  }

  interface McpToolInputs {
    'mcp__codex-computer-use__codex_cu': CodexCuInput
  }
}
