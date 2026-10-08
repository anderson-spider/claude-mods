import type { PantheonConfig } from './types'

// Valores padrão do spec (seção "Configuração"). Congelado depois da Task 1.
export const DEFAULT_CONFIG: PantheonConfig = {
  sandboxCap: 'workspace-write',
  noNetwork: false,
  foregroundMinutes: 5,
  disabledAgents: [],
  agents: {
    explorer: { model: 'gpt-6-luna', sandbox: 'read-only' },
    librarian: { model: 'gpt-6-luna', sandbox: 'read-only' },
    fixer: { model: 'gpt-6-luna', sandbox: 'workspace-write' },
    oracle: { model: 'opus' },
    designer: { model: 'inherit' },
  },
  council: {
    seats: {
      alpha: { engine: 'codex', model: 'gpt-6-astra', effort: 'high' },
      beta: { engine: 'claude', model: 'opus' },
    },
  },
}
