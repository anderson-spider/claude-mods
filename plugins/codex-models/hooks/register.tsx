import type { Register } from 'claude-code'

export const register: Register = on => {
  // Answers the command itself, so the markdown body is only a fallback for a plugin that did not load.
  on('command.run', { command: 'codex-models:status' }, () => ({ text: 'codex-models status is not implemented yet.' }))
}
