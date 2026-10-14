// Small dispatch/finish decision records. Pure: the write is injected. Only lifecycle metadata and task hashes,
// never task text, keys, paths or command output.
import type { Effort, Role } from './roles'
import type { PromptStatus } from './herdr'
import type { JevReason, Levels } from './effort'

/** Where the effort came from: Jev, the role's default, or the call's own `effort`. */
export type EffortSource = 'jev' | 'default' | 'pinned' | 'review-policy'

export type DecisionRecord = {
  v: 2
  ts: string
  role: Role
  agent: string
  effectiveAgent: string
  model: string
  effort: Effort
  /** True only when this dispatch started the agent with the chosen effort. */
  effortApplied: boolean
  source: EffortSource
  jevModel: string
  /** Expected level per dimension, rounded to one decimal; null when no assessment was used. */
  expected: Levels | null
  jevReason: JevReason | null
  taskHash: string
  started: boolean
  promptStatus: PromptStatus
  /** A Herdr error code or a short fixed reason; never output text. */
  reason: string | null
  durationMs: number
}

export type FinishRecord = { v: 2; action: 'finish'; ts: string; agent: string; effectiveAgent: string; uuid: string | null; closed: boolean; archived: boolean; reason: string | null }

/** FNV-1a, 32 bits, as 8 hex digits: matches one task to another without keeping the text. Not a cryptographic hash. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** `<home>/.claude/codex-team/decisions/<ts with ':' replaced>-<agent>.json`. */
export function decisionPath(home: string, ts: string, agent: string): string {
  return `${home.replace(/\/+$/, '')}/.claude/codex-team/decisions/${ts.replace(/:/g, '-')}-${agent.replace(/[^\w.-]/g, '_')}.json`
}

/** Writes the record; a failure is one log line and never reaches the caller. */
export async function saveDecision(io: { write: (path: string, text: string) => Promise<void>; log: (text: string) => void }, home: string | undefined, record: DecisionRecord | FinishRecord): Promise<void> {
  if (!home) return io.log('codex-team: decision not logged (no home)')
  const path = decisionPath(home, record.ts, record.effectiveAgent)
  await io.write('action' in record ? path.replace(/\.json$/, '.finish.json') : path, `${JSON.stringify(record)}\n`).catch(() => io.log('codex-team: decision not logged (write failed)'))
}
