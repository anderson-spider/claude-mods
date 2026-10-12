// Agent types as the HUD names them: the role, whether it is a Codex twin, the short name for a 12-cell column, and the
// plan step id an Agent call's description starts with.
import { truncate } from './width'

/** The lanes and role colors in table order (UI spec 3.2); any other type is `other`. */
export const ROLE_ORDER = ['lead', 'code-reader', 'research', 'designer', 'developer', 'tester', 'architect'] as const
export type Role = (typeof ROLE_ORDER)[number] | 'other'

export const CODEX_SUFFIX = '-codex'
/** The suffix on a twin's name in a 12-cell column. */
export const TWIN_MARK = '·cx'
/** The server-side advisor tool counts as a consult, never as a card. */
export const ADVISOR = 'advisor'

export type TypeInfo = {
  /** The role; `other` for any type that is not `crew:<role>[-codex]`. */
  role: Role
  /** A `crew:<role>-codex` twin. */
  isCodex: boolean
  /** The part after the last `:`, with a twin's `-codex` kept. */
  short: string
}

/** Reads an agent type such as `crew:developer`, `crew:code-reader-codex` or `general-purpose`. */
export function typeInfo(type: string): TypeInfo {
  const colon = type.lastIndexOf(':')
  const short = colon >= 0 ? type.slice(colon + 1) : type
  if (type.startsWith('crew:')) {
    const isCodex = short.endsWith(CODEX_SUFFIX)
    const base = isCodex ? short.slice(0, -CODEX_SUFFIX.length) : short
    const role = (ROLE_ORDER as readonly string[]).includes(base) && base !== 'lead' ? (base as Role) : 'other'
    if (role !== 'other') return { role, isCodex, short }
  }
  return { role: 'other', isCodex: false, short }
}

/** `crew:architect`, `crew:architect-codex` and the server `advisor` tool are consults. */
export function isConsultType(type: string): boolean {
  return type === ADVISOR || (type.startsWith('crew:') && typeInfo(type).role === 'architect')
}

/** The provider a type implies when nothing says otherwise: a `-codex` twin runs on Codex. */
export const providerOfType = (type: string): 'claude' | 'codex' => (typeInfo(type).isCodex ? 'codex' : 'claude')

/** The name of a lane or row, at most 12 cells: `developer`, `developer·cx`, `reader·cx`, `general-purp…`. */
export function displayName(type: string): string {
  const info = typeInfo(type)
  if (info.role === 'other') return truncate(info.short, 12)
  if (!info.isCodex) return info.role
  const base = info.role === 'code-reader' ? 'reader' : info.role
  return `${base}${TWIN_MARK}`
}

/** Position of a lane in the role table: base roles first, a role's twin right after it, then other types. */
export function laneRank(type: string): number {
  const info = typeInfo(type)
  const at = info.role === 'other' ? ROLE_ORDER.length : ROLE_ORDER.indexOf(info.role)
  return at * 2 + (info.isCodex ? 1 : 0)
}

/** The step id shape the brainstorm skill fixes: capital letters, digits, an optional lowercase suffix (`T3`, `T3b`). */
export const STEP_ID = /[A-Z]+\d+[a-z]?/
const LEADING_ID = new RegExp(`^\\s*(${STEP_ID.source})(?![A-Za-z0-9])`)
const ID_WORD = new RegExp(`(?<![A-Za-z0-9])(${STEP_ID.source})(?![A-Za-z0-9])`, 'g')

/** The step id an Agent call's description starts with (`T3: …`, `T3b contract suite`), or null. */
export function leadingStepId(description: string): string | null {
  return LEADING_ID.exec(description)?.[1] ?? null
}

/** The first of `known` that appears in the text as a whole word, in the text's order; null when none does. */
export function stepIdIn(text: string, known: ReadonlySet<string>): string | null {
  for (const match of text.matchAll(ID_WORD)) {
    const id = match[1] as string
    if (known.has(id)) return id
  }
  return null
}

/** Every step-id-shaped word in a text, in order, without repeats. */
export function idsIn(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(ID_WORD)) seen.add(match[1] as string)
  return [...seen]
}

// The tag Jev routing appends: ` · <model>/<effort>`, where the model is an alias or a hyphenated id (so `docs · v2/high` stays).
const TAG = /\s·\s(?:haiku|sonnet|opus|[a-z][a-z0-9]*-[\w.:[\]-]+)\/(?:low|medium|high|xhigh|max)$/i

/** The description as the lead wrote it, without a trailing Jev tag. */
export function stripTag(description: string): string {
  return description.trim().replace(TAG, '').trim()
}

/** The description without its leading step id and the `:` after it (`T3: contract suite` becomes `contract suite`). */
export function withoutStepId(description: string): string {
  const id = leadingStepId(description)
  if (id === null) return description.trim()
  const rest = description.trim().slice(id.length).replace(/^\s*[:\-–—]?\s*/, '')
  return rest === '' ? description.trim() : rest
}

/**
 * A step's short label: its text up to the first `:`, `;`, ` — ` or `(`, backticks removed. Text that starts with a cut
 * mark keeps the whole text.
 */
export function shortLabel(text: string): string {
  const plain = text.replace(/`/g, '').trim()
  const cut = plain.search(/:|;| — |\(/)
  const label = cut > 0 ? plain.slice(0, cut).trim() : plain
  return label === '' ? plain : label
}
