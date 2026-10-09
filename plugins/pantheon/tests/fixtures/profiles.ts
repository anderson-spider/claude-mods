import { loadConfig } from '../../hooks/config'
import type { PantheonConfig } from '../../hooks/types'

export async function resolved(profile: 'claude' | 'codex' | 'mixed', extra?: object): Promise<PantheonConfig> {
  const result = await loadConfig(async () => JSON.stringify({ profile, ...extra }), { user: 'fixture' })
  if (!result.ok) throw new Error(result.error)
  return result.config
}

export const MIXED = await resolved('mixed')
export const CODEX = await resolved('codex')
export const CLAUDE = await resolved('claude')
