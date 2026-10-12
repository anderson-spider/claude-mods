// Jev's routing of one Agent call: which of the lead's crew agents may be routed, the state Jev is given and how its
// answers become a model and an effort. Pure: the call to Jev is injected. The agent type is never rewritten; the
// answers only move model and effort, at most one step from the agent's defaults (and never below its floor), so a bad
// answer costs money, never a lane change.

import { EFFORTS, EFFORT_FLOOR, MODELS, MODEL_FLOORS, NATIVE_SUFFIX, SPECIALISTS } from './agents'
import type { Agent, Effort, Model } from './agents'
import type { AskFn } from './jev'
import { DEPTH_HIGH, DEPTH_TIE, DESCRIPTION_CHARS, PROMPT_CHARS, QUESTIONS, TIER_MIN_CONFIDENCE } from './questions'
import { head, redact } from './redact'
import type { RedactContext } from './redact'

const PREFIX = 'crew:'
/** The prompt is cut before redaction to this length, so a token cannot straddle the final cut. */
const REDACT_WINDOW = 4 * PROMPT_CHARS

/**
 * What routing acts on: a specialist, or a `-codex` twin. `base` names the specialist a twin copies; its presence means
 * the twin's model (any id) is never moved, only its effort.
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

export type Decision = {
  /** A model alias, or for a `-codex` twin its own id, which no answer moves. */
  model: string
  effort: Effort
  /** What Jev answered, for the log; undefined when the answer was absent or unusable. */
  tier?: Model
  tierConfidence?: number
  depth?: number
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const clamp = (index: number, low: number, high: number) => Math.min(high, Math.max(low, index))

/** The tier inside the agent's window: the default +-1, not below its floor. A model that is no alias (a `-codex` id) never moves. */
function decideModel(spec: Target, named: Model | undefined, confidence: unknown): string {
  const modelAt = MODELS.findIndex(m => m === spec.model)
  if (spec.base !== undefined || modelAt === -1) return spec.model
  const floor = MODELS.indexOf(MODEL_FLOORS[spec.name] ?? MODELS[0])
  const lowModel = Math.max(modelAt - 1, floor)
  const highModel = Math.min(modelAt + 1, MODELS.length - 1)
  if (named && isNumber(confidence) && confidence >= TIER_MIN_CONFIDENCE) {
    return MODELS[clamp(MODELS.indexOf(named), lowModel, highModel)] ?? spec.model
  }
  return spec.model
}

/**
 * Applies the answers inside the agent's window: the default tier +-1, not below its floor; effort the same, never below
 * `EFFORT_FLOOR`. A `-codex` twin keeps its model whatever the tier answer says; its effort follows the same rule.
 */
export function decide(spec: Target, answers: Record<string, Record<string, unknown>>): Decision {
  const tier = answers.tier
  const choice = tier?.choice
  const confidence = tier?.confidence
  const named = typeof choice === 'string' ? MODELS.find(m => m === choice) : undefined
  const model = decideModel(spec, named, confidence)

  const effortAt = EFFORTS.indexOf(spec.effort)
  const depth = answers.reasoning_depth?.score
  let effort = spec.effort
  if (isNumber(depth) && Math.abs(depth - DEPTH_HIGH) >= DEPTH_TIE) {
    const wanted = depth < DEPTH_HIGH ? EFFORTS.indexOf('medium') : EFFORTS.indexOf('high')
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

/** What Jev moved from the agent's defaults; undefined where the answer is the default or there is no answer. */
export type Moved = { model: string | undefined; effort: Effort | undefined }

export function moved(spec: Target, routed: Routed | undefined): Moved {
  return {
    // A twin's model is never sent: the spawn keeps the definition's.
    model: spec.base === undefined && routed && routed.decision.model !== spec.model ? routed.decision.model : undefined,
    effort: routed && routed.decision.effort !== spec.effort ? routed.decision.effort : undefined,
  }
}

/**
 * The notice of a decision. An effort that was moved but did not take shows the default the subagent runs on and says
 * so; otherwise the notice shows the effort of the answer.
 */
export function noticeText(spec: Target, routed: Routed, notApplied: Effort | undefined): string {
  const effort = notApplied === undefined
    ? `${routed.decision.effort} (jev)`
    : `${spec.effort} (jev; effort ${notApplied} not applied)`
  return `crew:${spec.name} -> ${routed.decision.model} · ${effort}`
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

/** The call's description with the model and effort Jev chose, as the task list shows it: `audit auth · opus/high`. */
export function taggedDescription(description: string, routed: Routed): string {
  return `${description} · ${routed.decision.model}/${routed.decision.effort}`
}

/** One line for the notice and the debug log; the prompt never appears in it. */
export function describe(spec: Target, routed: Routed, applied: { model?: string; effort?: Effort }): string {
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
