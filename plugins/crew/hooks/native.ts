// The `nativeCodex` option: a model per role, for the `-codex` twins. Pure: no host access.
import { SPECIALISTS } from './agents'

/** A role a `-codex` twin can copy: the name of one of `SPECIALISTS`. */
export type NativeRole = string

function isRole(value: string): value is NativeRole {
  return SPECIALISTS.some(specialist => specialist.name === value)
}

// A plain model id for the twin's `model`: alphanumeric first, then word characters, dots, colons or dashes, 64 at most.
const MODEL_ID = /^[A-Za-z0-9][\w.:-]{0,63}$/

/** Parses "developer=gpt-x, architect=gpt-y". Never throws; what it cannot use comes back in `errors`. */
export function parseCodexModels(text: unknown): { models: Partial<Record<NativeRole, string>>; errors: string[] } {
  const models: Partial<Record<NativeRole, string>> = {}
  const errors: string[] = []
  if (typeof text !== 'string') return { models, errors }
  for (const raw of text.split(/[,\n]/)) {
    const entry = raw.trim()
    if (!entry) continue
    const eq = entry.indexOf('=')
    const role = eq === -1 ? entry : entry.slice(0, eq).trim()
    const model = eq === -1 ? '' : entry.slice(eq + 1).trim()
    if (eq === -1) errors.push(`"${entry}": expected role=model`)
    else if (!isRole(role)) errors.push(`"${role}": unknown role`)
    else if (!MODEL_ID.test(model)) errors.push(`${role}: invalid model id`)
    else models[role] = model
  }
  return { models, errors }
}
