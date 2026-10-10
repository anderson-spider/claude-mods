import { loadConfig } from '../../hooks/config'
import type { PantheonConfig } from '../../hooks/types'

/** Loads a config from one in-memory user file (defaults when empty); throws when it is invalid. */
export async function resolved(extra: object = {}): Promise<PantheonConfig> {
  const result = await loadConfig(async () => JSON.stringify(extra), { user: 'fixture' })
  if (!result.ok) throw new Error(result.error)
  return result.config
}

/** The default config: every role and seat on its default Claude model. */
export const DEFAULTS = await resolved()
