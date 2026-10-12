// Fixed model ids for the five roles' Codex twins. Pure: no host access.
export const CODEX_MODELS = {
  'code-reader': 'gpt-6-luna',
  research: 'gpt-6-luna',
  designer: 'gpt-6-sol',
  developer: 'gpt-6-sol',
  architect: 'gpt-6-astra',
} as const

/** The gateway's provider prefix on the wire; the bare id names the twin in tags, notices and confirmations. */
export const CODEX_PREFIX = 'cx/'
