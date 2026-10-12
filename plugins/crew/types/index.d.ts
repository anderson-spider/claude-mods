// The crew's session state under `crew`.

/** Which provider serves a plain `crew:<role>` call: `codex` sends it to the role's registered Codex twin. */
export type CrewMode = 'claude' | 'codex'

declare module 'claude-code' {
  interface PluginState {
    'crew': {
      /** The running session's crew mode: set from the `mode` option at session start, switched by `/crew-mode`. */
      mode: CrewMode
    }
  }
}
