// What a routed subagent really ran on: its first step after the spawn resolved names the effort that went out, and
// the API's answer names the model. Pure: the step hook in register.tsx feeds it and does the writes.

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

/** True when the run matches the tag: the API's model id is of the planned family and the effort is the planned one. */
export function ranAsPlanned(planned: Planned, ran: Ran): boolean {
  return ran.model.includes(planned.model) && ran.effort === planned.effort
}

/** The transcript line: a confirmation, or what ran instead of the tag. */
export function confirmText(description: string, planned: Planned, ran: Ran): string {
  const what = `${ran.model} · ${ran.effort ?? 'no effort'}`
  return ranAsPlanned(planned, ran)
    ? `crew jev: ${description}: confirmed ${what}`
    : `crew jev: ${description}: ran ${what}, not ${planned.model}/${planned.effort}`
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
