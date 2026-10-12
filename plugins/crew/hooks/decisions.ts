// The decision log: one small JSON file per routed decision, so the thresholds can be revisited from data. Pure: the write
// and the log line are injected. A record holds numbers and short names only; never the prompt, the description, the
// key or a path.

import type { Effort } from './agents'
import type { Provider, Reading, Window } from './quota'

/** `<home>/.claude/crew/decisions`: the home is the trusted one, never the repository's. */
const DIR = '.claude/crew/decisions'
// A context suffix such as `[1m]` is part of a model id.
export const MODEL_ID = /^[\w./:[\]-]{1,64}$/

export type DecisionInput = {
  ts: string
  agent: string
  /** The type the lead asked for (`crew:developer`); `agent` is the one that ran, which differs when quota moved the call to a twin. */
  requested: string
  provider: Provider
  /** Why quota chose the provider (a fixed phrase with percentages); absent when it did not decide. */
  reason?: string
  /** The two readings the provider was chosen from; absent when quota routing is off. */
  claude?: Reading | null
  codex?: Reading | null
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

/** A window as logged: the percentage and the reset time, nothing else. */
type LoggedWindow = { percentUsed: number; resetsAt?: string }
export type LoggedReading = { fiveHour?: LoggedWindow; sevenDay?: LoggedWindow }

export type DecisionRecord = {
  v: 3
  ts: string
  agent: string
  requested: string
  provider: Provider
  reason: string | null
  /** The 5-hour and 7-day readings of both providers when the decision was made; null where not read. */
  quota: { claude: LoggedReading | null; codex: LoggedReading | null }
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

const REASON_CHARS = 80
const TIME = /^[\w:.+-]{1,40}$/

function loggedWindow(window: Window | undefined): LoggedWindow | undefined {
  if (!window || typeof window.percentUsed !== 'number' || !Number.isFinite(window.percentUsed)) return undefined
  return { percentUsed: window.percentUsed, ...(typeof window.resetsAt === 'string' && TIME.test(window.resetsAt) ? { resetsAt: window.resetsAt } : {}) }
}

/** A reading cut to percentages and reset times, whatever else the object carries. */
function loggedReading(reading: Reading | null | undefined): LoggedReading | null {
  if (!reading) return null
  const fiveHour = loggedWindow(reading.fiveHour)
  const sevenDay = loggedWindow(reading.sevenDay)
  return fiveHour || sevenDay ? { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) } : null
}

const numberOr = (value: number | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function decisionRecord(input: DecisionInput): DecisionRecord {
  return {
    v: 3,
    ts: input.ts,
    agent: input.agent,
    requested: input.requested,
    provider: input.provider,
    reason: input.reason ? input.reason.slice(0, REASON_CHARS) : null,
    quota: { claude: loggedReading(input.claude), codex: loggedReading(input.codex) },
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
 * Writes one record. Never rejects: a failure is one debug line, prefixed by what decided the call (`jev`, `quota`,
 * or `crew` for a medium fallback). Without a trusted home nothing is written.
 */
export async function saveDecision(io: DecisionIo, home: string | undefined, id: string, record: DecisionRecord, by: 'jev' | 'quota' | 'crew' = 'jev'): Promise<void> {
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
