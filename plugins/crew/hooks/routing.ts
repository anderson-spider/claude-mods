// Jev's routing of one Agent call: which of the lead's crew agents may be routed, the state Jev is given and how its
// answers become effort. Pure: the call to Jev is injected. The answers only move effort, at
// most one step from the agent's defaults (and never below its floor), so a bad answer costs money, never a lane change.
// The type is rewritten only by the codex crew mode in register.tsx, and only to the same role's registered twin (`twinFor`).

import { EFFORTS, EFFORT_FLOOR, MODELS, NATIVE_SUFFIX, SPECIALISTS } from './agents'
import type { Agent, Effort } from './agents'
import type { AskFn } from './jev'
import { DEPTH_HIGH, DEPTH_TIE, DESCRIPTION_CHARS, PROMPT_CHARS, QUESTIONS } from './questions'
import { head, redact } from './redact'
import type { RedactContext } from './redact'

const PREFIX = 'crew:'
/** The prompt is cut before redaction to this length, so a token cannot straddle the final cut. */
const REDACT_WINDOW = 4 * PROMPT_CHARS

/**
 * What routing acts on: a specialist, or a `-codex` twin. `base` names the specialist a twin copies.
 * Both keep their registered model; Jev moves only effort.
 */
export type Target = Agent<string> & { base?: string }

/**
 * The agent a spawn names, or undefined for anything Jev must leave alone: other types, forks, a given model and
 * a workflow script's agent (a hook can only refuse that spawn; a rewritten model would be ignored). A `-codex` twin is
 * routable only if it is among `twins` (the registered ones), and then for its effort alone.
 */
export function routable(
  e: { subagentType: string; fork?: boolean; model?: string; workflow?: unknown },
  twins: readonly Agent<string>[] = [],
): Target | undefined {
  if (e.fork || e.model || e.workflow) return undefined
  if (!e.subagentType.startsWith(PREFIX)) return undefined
  const name = e.subagentType.slice(PREFIX.length)
  const specialist = SPECIALISTS.find(s => s.name === name)
  if (specialist) return specialist
  const twin = twins.find(t => t.name === name)
  const base = name.endsWith(NATIVE_SUFFIX) ? name.slice(0, -NATIVE_SUFFIX.length) : undefined
  return twin && base !== undefined && SPECIALISTS.some(s => s.name === base) ? { ...twin, base } : undefined
}

/**
 * The registered Codex twin of the role a call names, as a routing `Target`, when the codex crew mode sends the call
 * there: a routable specialist call (no `model`, no fork, no workflow agent) that is not a teammate's. Undefined for
 * anything else, a twin the lead named included (an explicit choice is never moved) and a role with no registered twin.
 */
export function twinFor(
  e: { subagentType: string; fork?: boolean; model?: string; workflow?: unknown; isTeammate?: boolean },
  twins: readonly Agent<string>[],
): Target | undefined {
  if (e.isTeammate) return undefined
  const spec = routable(e, twins)
  if (!spec || spec.base !== undefined) return undefined
  return routable({ ...e, subagentType: `${PREFIX}${spec.name}${NATIVE_SUFFIX}` }, twins)
}

export type Decision = {
  effort: Effort
  /** What Jev answered, for the log; undefined when the answer was absent or unusable. */
  depth?: number
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const clamp = (index: number, low: number, high: number) => Math.min(high, Math.max(low, index))

/** Applies depth inside the default effort +-1 window, never below `EFFORT_FLOOR`; models stay with the role. */
export function decide(spec: Target, answers: Record<string, Record<string, unknown>>): Decision {
  const effortAt = EFFORTS.indexOf(spec.effort)
  const depth = answers.reasoning_depth?.score
  let effort = spec.effort
  if (isNumber(depth) && Math.abs(depth - DEPTH_HIGH) >= DEPTH_TIE) {
    const wanted = depth < DEPTH_HIGH ? EFFORTS.indexOf('medium') : EFFORTS.indexOf('high')
    effort = EFFORTS[clamp(wanted, Math.max(effortAt - 1, EFFORTS.indexOf(EFFORT_FLOOR)), Math.min(effortAt + 1, EFFORTS.length - 1))] ?? spec.effort
  }

  return {
    effort,
    ...(isNumber(depth) ? { depth } : {}),
  }
}

/** The state Jev reads: the role, the call's short description and the redacted, capped prompt as its own field. */
export function stateOf(spec: Target, e: { prompt: string; description?: string }, ctx: RedactContext) {
  return {
    agent: { type: spec.base ?? spec.name, description: head(redact(String(e.description ?? ''), ctx), DESCRIPTION_CHARS) },
    task: { prompt: head(redact(head(String(e.prompt ?? ''), REDACT_WINDOW), ctx), PROMPT_CHARS) },
  }
}

export type Routed = { decision: Decision; jevModel?: string; ms: number }

/** Asks Jev about one call. Rejects with the client's failure; the caller fails open. */
export async function route(
  ask: AskFn,
  ctx: RedactContext,
  spec: Target,
  e: { prompt: string; description?: string },
): Promise<Routed> {
  const reply = await ask(QUESTIONS, stateOf(spec, e, ctx))
  return { decision: decide(spec, reply.answers), jevModel: reply.model, ms: reply.ms }
}

/** Explicit medium fallback when Jev has no answer, also used for a codex-mode switch without Jev. */
export function defaultsOf(_spec: Target): Routed {
  return { decision: { effort: 'medium' }, ms: 0 }
}

/** What Jev moved from the agent's defaults; undefined where the answer is the default or there is no answer. */
export type Moved = { effort: Effort | undefined }

export function moved(spec: Target, routed: Routed | undefined): Moved {
  return {
    effort: routed && routed.decision.effort !== spec.effort ? routed.decision.effort : undefined,
  }
}

/** A call the codex crew mode moved to its role's twin: the type the lead asked for. */
export type Switch = { requested: string }

/**
 * The notice shows known configuration, or explicitly unknown effort when an apply request could not bind.
 * A rejected request names the effort that did not take. A switched call names the type asked for; `jev` is false
 * when Jev gave no answer, so medium is crew's fallback and not Jev's.
 */
export function noticeText(spec: Target, routed: Routed, notApplied: Effort | undefined, via?: Switch, jev = true, applied?: Effort | null): string {
  const by = jev ? 'jev' : 'crew'
  const tail = notApplied !== undefined ? ` (${by}; effort ${notApplied} not applied)` : jev ? ' (jev)' : ''
  const known = applied === undefined ? (notApplied === undefined ? routed.decision.effort : spec.effort) : applied
  const head = via ? `${via.requested} -> Codex (crew mode) · ` : `crew:${spec.name} -> `
  return `${head}${spec.model} · ${known ?? 'effort unknown'}${tail}`
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The description without a trailing tag of `taggedDescription`. Only a tag the plugin could have written is stripped:
 * a model alias, or one of `models` (the ids of the registered `-codex` twins), so text that merely looks like one
 * (`docs · v2/high`) stays.
 */
export function untagged(description: string, models: readonly string[] = []): string {
  const names = [...MODELS, ...models].map(escaped).join('|')
  return description.replace(new RegExp(` · (?:${names})/(?:low|medium|high)$`), '')
}

/** The call's description with the role model and chosen effort, as the task list shows it. */
export function taggedDescription(description: string, routed: Routed, model: string): string {
  return `${description} · ${model}/${routed.decision.effort}`
}

/** One line for the notice and the debug log; the prompt never appears in it. */
export function describe(spec: Target, routed: Routed, applied: { effort?: Effort | null }): string {
  const { decision, jevModel, ms } = routed
  const parts = [
    `crew:${spec.name}`,
    `depth=${decision.depth === undefined ? '-' : decision.depth.toFixed(2)}`,
    `model=${spec.model} (default)`,
    `effort=${applied.effort === null ? 'unknown' : applied.effort ?? `${spec.effort} (default)`}`,
    `jev=${jevModel ?? '-'}`,
    `${ms}ms`,
  ]
  return parts.join(' ')
}
