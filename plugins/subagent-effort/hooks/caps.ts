// The highest effort Jev may pick per agent type: read-only agents such as Explore and web-fetch do well at medium, and
// a higher rating there spends tokens a search does not need. Pure: register.tsx passes the option in.
import { EFFORTS } from './effort'
import type { Effort } from './effort'

export type Caps = Readonly<Record<string, Effort>>

/** The caps when the `caps` option is not set; `none` turns them off. */
export const DEFAULT_CAPS = 'Explore=medium,web-fetch=medium,claude-code-guide=low,statusline-setup=low'

const TYPE = /^[A-Za-z0-9][\w.:@-]{0,79}$/

/**
 * The `caps` option as `type=effort` pairs split by commas; absent or blank is `DEFAULT_CAPS`, `none` no caps. A pair
 * that is not an agent type and one of Jev's efforts is dropped and named, so the caller can log it.
 */
export function capsOf(option: unknown): { caps: Caps; invalid: string[] } {
  const text = typeof option === 'string' && option.trim() ? option.trim() : DEFAULT_CAPS
  if (text === 'none') return { caps: {}, invalid: [] }
  const caps: Record<string, Effort> = {}, invalid: string[] = []
  for (const pair of text.split(',').map(part => part.trim()).filter(Boolean)) {
    const [type = '', effort = '', ...rest] = pair.split('=').map(part => part.trim())
    if (!rest.length && TYPE.test(type) && (EFFORTS as readonly string[]).includes(effort)) caps[type] = effort as Effort
    else invalid.push(pair.slice(0, 80))
  }
  return { caps, invalid }
}

/** Jev's effort held to the agent type's cap: the cap when Jev picked higher, else Jev's own; whether the cap applied. */
export function capped(effort: Effort, agentType: string, caps: Caps): { effort: Effort; cap: Effort | null } {
  const cap = caps[agentType]
  if (cap === undefined) return { effort, cap: null }
  const rank = (e: Effort) => (EFFORTS as readonly string[]).indexOf(e)
  return rank(effort) > rank(cap) ? { effort: cap, cap } : { effort, cap: null }
}
