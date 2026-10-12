// What a routed subagent really ran on: its first step after the spawn resolved names the effort that went out, and
// the API's answer names the model. Pure: the step hook in register.tsx feeds it and does the writes.

import { MODELS } from './agents'
import { MODEL_ID } from './decisions'
import type { DecisionRecord } from './decisions'

/** What the task's tag promised: the model alias and the effort Jev chose. */
export type Planned = { model: string; effort: string }
/** What the request carried: the model id the API reported and the effort sent (absent for a model without one). */
export type Ran = { model: string; effort: string | undefined }

/** One routed subagent waiting for its first step; `saved` is the spawn's own write, which the confirmation follows. */
export type Pending = {
  description: string
  planned: Planned
  record: DecisionRecord
  saved: Promise<void>
}

/** Routed subagents still to be confirmed; the oldest go first. */
const CAP = 64

const ALIASES: readonly string[] = MODELS

/**
 * A model id as compared: lower case, without a trailing context suffix (`[1m]`) and without a trailing effort suffix
 * (`-high`, `:high`), which a proxy may add to the id it receives or report. `max` is not stripped: `gpt-x-codex-max` is a model.
 */
export function normalizeModel(id: string): string {
  return id.trim().toLowerCase().replace(/\[\d+m\]$/, '').replace(/[-:](?:low|medium|high|xhigh)$/, '')
}

/** A trailing snapshot date, as an upstream names a dated release of a model: `-2026-05-01` or `-20260501`. */
const DATE_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/

/**
 * True when the run matches the tag: the effort is the planned one and the model is. An alias (`opus`) is matched by the
 * Claude id that contains it (`claude-opus-5-5`); any other id must equal the planned one once normalized, or be its
 * dated release (`gpt-6-astra-2026-05-01`), so `gpt-6` does not accept `gpt-6-mini`.
 */
export function ranAsPlanned(planned: Planned, ran: Ran): boolean {
  if (ran.effort !== planned.effort) return false
  const wanted = normalizeModel(planned.model)
  const got = normalizeModel(ran.model)
  return ALIASES.includes(wanted) ? got.includes(wanted) : got === wanted || got.replace(DATE_SUFFIX, '') === wanted
}

/** The transcript line: a confirmation, or what ran instead of the tag. */
export function confirmText(description: string, planned: Planned, ran: Ran): string {
  // The proxy reports the id: only a well-formed one is written, as in the decision record.
  const shown = MODEL_ID.test(ran.model) ? ran.model : 'unknown model'
  const what = `${shown} · ${ran.effort ?? 'no effort'}`
  return ranAsPlanned(planned, ran)
    ? `jev: ${description}: confirmed ${what}`
    : `jev: ${description}: ran ${what}, not ${planned.model}/${planned.effort}`
}

export function createConfirmations() {
  const pending = new Map<string, Pending>()
  return {
    add(agentId: string, entry: Pending): void {
      pending.delete(agentId)
      pending.set(agentId, entry)
      while (pending.size > CAP) pending.delete(pending.keys().next().value as string)
    },
    /** The entry of a stepping agent, taken once: later steps find nothing. */
    take(agentId: string): Pending | undefined {
      const entry = pending.get(agentId)
      pending.delete(agentId)
      return entry
    },
  }
}

export type Confirmations = ReturnType<typeof createConfirmations>
