import type { PantheonConfig, Role } from './types'

export const ROLES: readonly Role[] = ['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux']

function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) freeze(child)
  }
  return Object.freeze(value)
}

export const DEFAULT_CONFIG: PantheonConfig = freeze({
  disabledAgents: [],
  agents: {
    'code-reader': { model: 'haiku' },
    'docs-reader': { model: 'haiku' },
    developer: { model: 'sonnet' },
    architect: { model: 'opus' },
    qa: { model: 'sonnet' },
    ux: { model: 'sonnet' },
  },
  council: { seats: {
    alpha: { model: 'opus' },
    beta: { model: 'sonnet' },
  } },
})
