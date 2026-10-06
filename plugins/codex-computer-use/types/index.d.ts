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

declare module 'claude-code' {
  interface PluginState {
    'codex-computer-use': { asking: CodexAsking | null }
  }
}
