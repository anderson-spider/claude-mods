// The decision log: one small JSON file per routed decision, so the thresholds can be tuned from data. Pure: the write
// and the log line are injected. A record holds numbers and short names only; never the prompt, the description, the
// key or a path.

import type { Effort, Model } from './agents'

/** `<home>/.claude/crew/decisions`: the home is the trusted one, never the repository's. */
const DIR = '.claude/crew/decisions'
const MODEL_ID = /^[\w.:-]{1,64}$/

export type DecisionInput = {
  ts: string
  agent: string
  tier?: Model
  confidence?: number
  depth?: number
  defaultModel: Model
  model: Model
  defaultEffort: Effort
  effortPlanned: Effort
  /** The effort the subagent runs on: the planned one when it took, else the default. */
  effortApplied: Effort
  /** What the effort book said when the spawn resolved; absent when nothing was bound. */
  bind?: string
  jevModel?: string
  durationMs: number
  description?: string
}

export type DecisionRecord = {
  v: 1
  ts: string
  agent: string
  tier: Model | null
  confidence: number | null
  depth: number | null
  defaultModel: Model
  model: Model
  defaultEffort: Effort
  effortPlanned: Effort
  effortApplied: Effort
  bind: string | null
  jevModel: string | null
  durationMs: number
  descriptionHash: string
  applied: { model: boolean; effort: boolean }
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
    v: 1,
    ts: input.ts,
    agent: input.agent,
    tier: input.tier ?? null,
    confidence: numberOr(input.confidence),
    depth: numberOr(input.depth),
    defaultModel: input.defaultModel,
    model: input.model,
    defaultEffort: input.defaultEffort,
    effortPlanned: input.effortPlanned,
    effortApplied: input.effortApplied,
    bind: input.bind ?? null,
    jevModel: input.jevModel !== undefined && MODEL_ID.test(input.jevModel) ? input.jevModel : null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    descriptionHash: fnv1a(input.description ?? ''),
    applied: { model: input.model !== input.defaultModel, effort: input.effortApplied !== input.defaultEffort },
    outcome: null,
  }
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

/** Writes one record. Never rejects: a failure is one debug line. Without a trusted home nothing is written. */
export async function saveDecision(io: DecisionIo, home: string | undefined, id: string, record: DecisionRecord): Promise<void> {
  if (!home) {
    io.log('crew jev: decision not logged (no trusted home)')
    return
  }
  try {
    await io.write(decisionPath(home, record.ts, id), `${JSON.stringify(record)}\n`)
  } catch {
    io.log('crew jev: decision not logged (write failed)')
  }
}
