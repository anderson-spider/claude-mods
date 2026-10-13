// Fixed model ids for the three helpers' Codex twins. Pure: no host access.
export const CODEX_MODELS = {
  planner: 'gpt-6-astra',
  challenger: 'gpt-6-astra',
  digger: 'gpt-6-luna',
} as const

/** The gateway's provider prefix on the wire; the bare id names the twin in tags, notices and confirmations. */
export const CODEX_PREFIX = 'cx/'
