// The `codexModels` option: a model per role. Pure: no host access.
import { isCodexRole } from './roles'
import type { CodexRole } from './types'

// The first character is alphanumeric so an id can never read as a flag.
const MODEL_ID = /^[A-Za-z0-9][\w.:-]{0,63}$/

/** Parses "developer=gpt-x, architect=gpt-y". Never throws; what it cannot use comes back in `errors`. */
export function parseCodexModels(text: unknown): { models: Partial<Record<CodexRole, string>>; errors: string[] } {
  const models: Partial<Record<CodexRole, string>> = {}
  const errors: string[] = []
  if (typeof text !== 'string') return { models, errors }
  for (const raw of text.split(/[,\n]/)) {
    const entry = raw.trim()
    if (!entry) continue
    const eq = entry.indexOf('=')
    const role = eq === -1 ? entry : entry.slice(0, eq).trim()
    const model = eq === -1 ? '' : entry.slice(eq + 1).trim()
    if (eq === -1) errors.push(`"${entry}": expected role=model`)
    else if (!isCodexRole(role)) errors.push(`"${role}": unknown role`)
    else if (!MODEL_ID.test(model)) errors.push(`${role}: invalid model id`)
    else models[role] = model
  }
  return { models, errors }
}
