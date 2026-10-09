import type { Engine, PantheonConfig, Role, Sandbox } from './types'

export const ROLES: readonly Role[] = ['explorer', 'librarian', 'executor', 'oracle', 'designer', 'git']
export const ROLE_SANDBOX: Record<Role, Sandbox> = {
  explorer: 'read-only', librarian: 'read-only', executor: 'workspace-write',
  oracle: 'read-only', designer: 'workspace-write', git: 'workspace-write',
}

export type ProfileEntries = {
  agents: Record<Role, { engine: Engine; model?: string; effort?: string }>
  council: { seats: Record<string, { engine?: Engine; model?: string; effort?: string }> }
}

export const BASE_DEFAULTS = {
  sandboxCap: 'workspace-write' as Sandbox,
  noNetwork: false,
  foregroundMinutes: 5,
  disabledAgents: [] as string[],
  agents: Object.fromEntries(ROLES.map(role => [role, { sandbox: ROLE_SANDBOX[role] }])) as Record<Role, { sandbox: Sandbox }>,
}

export const BUILTIN_PROFILES: Record<'claude' | 'codex' | 'mixed', ProfileEntries> = {
  claude: {
    agents: {
      explorer: { engine: 'claude', model: 'haiku' },
      librarian: { engine: 'claude', model: 'haiku' },
      executor: { engine: 'claude', model: 'sonnet' },
      oracle: { engine: 'claude', model: 'opus' },
      designer: { engine: 'claude', model: 'sonnet' },
      git: { engine: 'claude', model: 'haiku' },
    },
    council: { seats: {
      alpha: { engine: 'claude', model: 'opus' },
      beta: { engine: 'claude', model: 'sonnet' },
    } },
  },
  codex: {
    agents: {
      explorer: { engine: 'codex', model: 'gpt-6-luna', effort: 'high' },
      librarian: { engine: 'codex', model: 'gpt-6-luna', effort: 'high' },
      executor: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      oracle: { engine: 'codex', model: 'gpt-6-astra', effort: 'high' },
      designer: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      git: { engine: 'codex', model: 'gpt-6-luna', effort: 'low' },
    },
    council: { seats: {
      alpha: { engine: 'codex', model: 'gpt-6-astra', effort: 'high' },
      beta: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    } },
  },
  mixed: {
    agents: {
      explorer: { engine: 'codex', model: 'gpt-6-luna', effort: 'high' },
      librarian: { engine: 'codex', model: 'gpt-6-luna', effort: 'high' },
      executor: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      oracle: { engine: 'claude', model: 'opus' },
      designer: { engine: 'claude', model: 'sonnet' },
      git: { engine: 'codex', model: 'gpt-6-luna', effort: 'low' },
    },
    council: { seats: {
      alpha: { engine: 'codex', model: 'gpt-6-astra', effort: 'high' },
      beta: { engine: 'claude', model: 'opus' },
    } },
  },
}

function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) freeze(child)
  }
  return Object.freeze(value)
}

export const DEFAULT_CONFIG: PantheonConfig = freeze({
  ...BASE_DEFAULTS,
  profile: 'claude',
  disabledAgents: [],
  agents: Object.fromEntries(ROLES.map(role => [role, {
    ...BASE_DEFAULTS.agents[role], ...BUILTIN_PROFILES.claude.agents[role],
  }])) as PantheonConfig['agents'],
  council: { seats: Object.fromEntries(Object.entries(BUILTIN_PROFILES.claude.council.seats)
    .map(([name, seat]) => [name, { ...seat }])) as PantheonConfig['council']['seats'] },
})
