import type { PantheonConfig, Role } from './types'

export const ROLES: readonly Role[] = ['explorer', 'librarian', 'executor', 'oracle', 'designer', 'git']

function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) freeze(child)
  }
  return Object.freeze(value)
}

export const DEFAULT_CONFIG: PantheonConfig = freeze({
  disabledAgents: [],
  agents: {
    explorer: { model: 'haiku' },
    librarian: { model: 'haiku' },
    executor: { model: 'sonnet' },
    oracle: { model: 'opus' },
    designer: { model: 'sonnet' },
    git: { model: 'haiku' },
  },
  council: { seats: {
    alpha: { model: 'opus' },
    beta: { model: 'sonnet' },
  } },
})
