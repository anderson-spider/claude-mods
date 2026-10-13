// The decision log: one small JSON file per routed decision, so the thresholds can be revisited from data. Pure: the write
// and the log line are injected. A record holds numbers and short names only; never the prompt, the description, the
// key or a path.

import type { Effort } from './agents'

/** Who serves the agent that ran: Anthropic for a Claude role, OpenAI for a `-codex` twin. */
export type Provider = 'claude' | 'codex'

/** `<home>/.claude/crew/decisions`: the home is the trusted one, never the repository's. */
const DIR = '.claude/crew/decisions'
// A context suffix such as `[1m]` is part of a model id.
export const MODEL_ID = /^[\w./:[\]-]{1,64}$/

export type DecisionInput = {
  ts: string
  agent: string
  /** The type the main session asked for (`crew:digger`); `agent` is the one that ran, which differs when the codex crew mode moved the call to a twin. */
  requested: string
  provider: Provider
  depth?: number
  defaultEffort: Effort
  effortPlanned: Effort
  /** Known request configuration, or null when a first step prevented binding; observed execution is in `ran`. */
  effortApplied: Effort | null
  /** Claude's effort-book outcome, or `suffix` for a successful twin spawn using a wire model suffix (defaults included). */
  bind?: string
  jevModel?: string
  durationMs: number
  description?: string
}

export type DecisionRecord = {
  v: 4
  ts: string
  agent: string
  requested: string
  provider: Provider
  depth: number | null
  defaultEffort: Effort
  effortPlanned: Effort
  effortApplied: Effort | null
  bind: string | null
  jevModel: string | null
  durationMs: number
  descriptionHash: string
  applied: { effort: boolean }
  /** What the first confirmed step ran on: the model id the API reported and the effort sent; null until then. */
  ran: { model: string | null; effort: string | null } | null
  /** Filled in by hand when annotating: whether the choice turned out right. */
  outcome: null
}

/** FNV-1a, 32 bits, as 8 hex digits: matches one call to another without keeping the text. Not a cryptographic hash. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const numberOr = (value: number | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function decisionRecord(input: DecisionInput): DecisionRecord {
  return {
    v: 4,
    ts: input.ts,
    agent: input.agent,
    requested: input.requested,
    provider: input.provider,
    depth: numberOr(input.depth),
    defaultEffort: input.defaultEffort,
    effortPlanned: input.effortPlanned,
    effortApplied: input.effortApplied,
    bind: input.bind ?? null,
    jevModel: input.jevModel !== undefined && MODEL_ID.test(input.jevModel) ? input.jevModel : null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    descriptionHash: fnv1a(input.description ?? ''),
    applied: { effort: input.effortApplied !== null && input.effortApplied !== input.defaultEffort },
    ran: null,
    outcome: null,
  }
}

/** The record with what ran; a model id outside the safe shape is kept as null. */
export function withRan(record: DecisionRecord, ran: { model: string; effort: string | undefined }): DecisionRecord {
  return { ...record, ran: { model: MODEL_ID.test(ran.model) ? ran.model : null, effort: ran.effort ?? null } }
}

/** `<home>/.claude/crew/decisions/<ts with ':' replaced>-<id>.json`; the id is cut to safe characters. */
export function decisionPath(home: string, ts: string, id: string): string {
  const name = `${ts.replace(/:/g, '-')}-${id.replace(/[^\w.-]/g, '_').slice(0, 64) || 'call'}.json`
  return `${home.replace(/\/+$/, '')}/${DIR}/${name}`
}

export type DecisionIo = {
  write: (path: string, text: string) => Promise<void>
  log: (text: string) => void
}

/**
 * Writes one record. Never rejects: a failure is one debug line, prefixed by what decided the call (`jev`, or `crew`
 * for a medium fallback). Without a trusted home nothing is written.
 */
export async function saveDecision(io: DecisionIo, home: string | undefined, id: string, record: DecisionRecord, by: 'jev' | 'crew' = 'jev'): Promise<void> {
  const prefix = by === 'crew' ? 'crew' : `crew ${by}`
  if (!home) {
    io.log(`${prefix}: decision not logged (no trusted home)`)
    return
  }
  try {
    await io.write(decisionPath(home, record.ts, id), `${JSON.stringify(record)}\n`)
  } catch {
    io.log(`${prefix}: decision not logged (write failed)`)
  }
}
