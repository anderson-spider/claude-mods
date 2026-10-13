// The pure part of a routed spawn: what the call sends (its description, the twin's suffix and the effort book's apply
// policy) and the effort the subagent is known to run on. The mode ladder, the Jev request, the effort book, the
// decision log and the notice are host work and stay in register.tsx. Pure: no host access.

import type { Effort } from './agents'
import type { BindOutcome } from './effort'
import { CODEX_PREFIX } from './native'
import { moved, taggedDescription } from './routing'
import type { Routed, Target } from './routing'

/** What a routed spawn sends, and what the effort book records for it. */
export type SpawnRequest = {
  /** The task description with the chosen effort, as the task list shows it. */
  description: string
  /** A twin's model with the effort suffix (`cx/<model>-<effort>`), which the gateway routes ahead of the host's effort. */
  suffix?: string
  /** Whether the book entry is an apply request: an effort change, or a Jev failure that asks for the role default. */
  requestedApply: boolean
  /** The effort the book entry starts the subagent with when nothing else binds it: the change, else the role default. */
  bookEffort: Effort
}

/**
 * The request for one routed call. `enabled` is whether Jev routing runs and `jevAnswered` whether Jev's answer is what
 * was routed. A failure explicitly requests the role default; a twin is sent with its suffix only.
 */
export function spawnRequest(
  spec: Target,
  routed: Routed,
  input: { enabled: boolean; jevAnswered: boolean; description: string },
): SpawnRequest {
  const change = moved(spec, routed)
  const suffix = spec.base !== undefined ? `${CODEX_PREFIX}${spec.model}-${routed.decision.effort}` : undefined
  return {
    description: taggedDescription(input.description, routed, spec.model),
    ...(suffix === undefined ? {} : { suffix }),
    requestedApply: change.effort !== undefined || (input.enabled && !input.jevAnswered),
    bookEffort: change.effort ?? spec.effort,
  }
}

/**
 * The effort a subagent runs on, as crew knows it. A twin's suffix decides, then the book's binding of the id, then the
 * routed effort when the entry took (`applied`, `matched` or a suffix). An apply request that did not bind is `null`:
 * unknown, never a claimed change from the default. Otherwise the role's default.
 */
export function appliedEffort(input: {
  suffix: boolean
  outcome: BindOutcome | 'suffix' | undefined
  bound: Effort | undefined
  routed: Routed
  requestedApply: boolean
  spec: Target
}): Effort | null {
  if (input.suffix) return input.routed.decision.effort
  if (input.bound !== undefined) return input.bound
  const took = input.outcome === 'suffix' || input.outcome === 'applied' || input.outcome === 'matched'
  if (took) return input.routed.decision.effort
  return input.requestedApply ? null : input.spec.effort
}
