// Jev's routing of one Agent call: which of the lead's crew agents may be routed, the state Jev is given and how its
// answers become a model and an effort. Pure: the call to Jev is injected. The agent type is never rewritten; the
// answers only move model and effort, at most one step from the agent's defaults (and never below its floor), so a bad
// answer costs money, never a lane change.

import { EFFORTS, EFFORT_FLOOR, MODELS, MODEL_FLOORS, SPECIALISTS } from './agents'
import type { Effort, Model, Specialist } from './agents'
import type { AskFn } from './jev'
import { DEPTH_BOUNDS, DEPTH_TIE, DESCRIPTION_CHARS, PROMPT_CHARS, QUESTIONS, TIER_MIN_CONFIDENCE } from './questions'
import { head, redact } from './redact'
import type { RedactContext } from './redact'

const PREFIX = 'crew:'
/** The prompt is cut before redaction to this length, so a token cannot straddle the final cut. */
const REDACT_WINDOW = 4 * PROMPT_CHARS

/**
 * The specialist a spawn names, or undefined for anything Jev must leave alone: other types, forks, a given model and
 * a workflow script's agent (a hook can only refuse that spawn; a rewritten model would be ignored).
 */
export function routable(e: { subagentType: string; fork?: boolean; model?: string; workflow?: unknown }): Specialist | undefined {
  if (e.fork || e.model || e.workflow) return undefined
  if (!e.subagentType.startsWith(PREFIX)) return undefined
  const name = e.subagentType.slice(PREFIX.length)
  return SPECIALISTS.find(s => s.name === name)
}

export type Decision = {
  model: Model
  effort: Effort
  /** What Jev answered, for the log; undefined when the answer was absent or unusable. */
  tier?: Model
  tierConfidence?: number
  depth?: number
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const clamp = (index: number, low: number, high: number) => Math.min(high, Math.max(low, index))

/** Applies the answers inside the agent's window: the default tier +-1, not below its floor; effort the same, never below `EFFORT_FLOOR`. */
export function decide(spec: Specialist, answers: Record<string, Record<string, unknown>>): Decision {
  const modelAt = MODELS.indexOf(spec.model)
  const floor = MODELS.indexOf(MODEL_FLOORS[spec.name] ?? MODELS[0])
  const lowModel = Math.max(modelAt - 1, floor)
  const highModel = Math.min(modelAt + 1, MODELS.length - 1)

  const tier = answers.tier
  const choice = tier?.choice
  const confidence = tier?.confidence
  const named = typeof choice === 'string' ? MODELS.find(m => m === choice) : undefined
  let model = spec.model
  if (named && isNumber(confidence) && confidence >= TIER_MIN_CONFIDENCE) {
    model = MODELS[clamp(MODELS.indexOf(named), lowModel, highModel)] ?? spec.model
  }

  const effortAt = EFFORTS.indexOf(spec.effort)
  const depth = answers.reasoning_depth?.score
  let effort = spec.effort
  if (isNumber(depth) && !DEPTH_BOUNDS.some(bound => Math.abs(depth - bound) < DEPTH_TIE)) {
    const wanted = depth < DEPTH_BOUNDS[0] ? 0 : depth < DEPTH_BOUNDS[1] ? 1 : 2
    effort = EFFORTS[clamp(wanted, Math.max(effortAt - 1, EFFORTS.indexOf(EFFORT_FLOOR)), Math.min(effortAt + 1, EFFORTS.length - 1))] ?? spec.effort
  }

  return {
    model,
    effort,
    ...(named ? { tier: named } : {}),
    ...(isNumber(confidence) ? { tierConfidence: confidence } : {}),
    ...(isNumber(depth) ? { depth } : {}),
  }
}

/** The state Jev reads: the role, the call's short description and the redacted, capped prompt as its own field. */
export function stateOf(spec: Specialist, e: { prompt: string; description?: string }, ctx: RedactContext) {
  return {
    agent: { type: spec.name, description: head(redact(String(e.description ?? ''), ctx), DESCRIPTION_CHARS) },
    task: { prompt: head(redact(head(String(e.prompt ?? ''), REDACT_WINDOW), ctx), PROMPT_CHARS) },
  }
}

export type Routed = { decision: Decision; jevModel?: string; ms: number }

/** Asks Jev about one call. Rejects with the client's failure; the caller fails open. */
export async function route(
  ask: AskFn,
  ctx: RedactContext,
  spec: Specialist,
  e: { prompt: string; description?: string },
): Promise<Routed> {
  const reply = await ask(QUESTIONS, stateOf(spec, e, ctx))
  return { decision: decide(spec, reply.answers), jevModel: reply.model, ms: reply.ms }
}

/** What Jev moved from the agent's defaults; undefined where the answer is the default or there is no answer. */
export type Moved = { model: Model | undefined; effort: Effort | undefined }

export function moved(spec: Specialist, routed: Routed | undefined): Moved {
  return {
    model: routed && routed.decision.model !== spec.model ? routed.decision.model : undefined,
    effort: routed && routed.decision.effort !== spec.effort ? routed.decision.effort : undefined,
  }
}

/**
 * The notice of a decision. An effort that was moved but did not take shows the default the subagent runs on and says
 * so; otherwise the notice shows the effort of the answer.
 */
export function noticeText(spec: Specialist, routed: Routed, notApplied: Effort | undefined): string {
  const effort = notApplied === undefined
    ? `${routed.decision.effort} (jev)`
    : `${spec.effort} (jev; effort ${notApplied} not applied)`
  return `crew:${spec.name} -> ${routed.decision.model} · ${effort}`
}

const TAG = / · (?:haiku|sonnet|opus)\/(?:low|medium|high)$/

/** The description without a trailing tag of `taggedDescription`. */
export function untagged(description: string): string {
  return description.replace(TAG, '')
}

/** The call's description with the model and effort Jev chose, as the task list shows it: `audit auth · opus/high`. */
export function taggedDescription(description: string, routed: Routed): string {
  return `${description} · ${routed.decision.model}/${routed.decision.effort}`
}

/** One line for the notice and the debug log; the prompt never appears in it. */
export function describe(spec: Specialist, routed: Routed, applied: { model?: Model; effort?: Effort }): string {
  const { decision, jevModel, ms } = routed
  const parts = [
    `crew:${spec.name}`,
    `tier=${decision.tier ?? '-'}${decision.tierConfidence === undefined ? '' : `@${decision.tierConfidence.toFixed(2)}`}`,
    `depth=${decision.depth === undefined ? '-' : decision.depth.toFixed(2)}`,
    `model=${applied.model ?? `${spec.model} (default)`}`,
    `effort=${applied.effort ?? `${spec.effort} (default)`}`,
    `jev=${jevModel ?? '-'}`,
    `${ms}ms`,
  ]
  return parts.join(' ')
}
