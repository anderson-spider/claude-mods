// Assessment: asks Jev the router's questions and maps the answers through its table. Host access is injected; only redacted task text leaves the machine.
import { classifyFailure, createJev, JevFailure } from './jev'
import type { Answers, Breaker, Gate, JevFailureReason, JevIo } from './jev'
import { resolveAccess } from './key'
import type { KeyIo, Off } from './key'
import { head, redact, REDACTED } from './redact'
import { defaultOf, DIMENSIONS, POLICY, QUESTIONS, routeOf } from './router'
import type { Dimension } from './router'
import type { Pair, Role } from './roles'

export const JEV_MODEL = 'jev-1.13.0'
export const TASK_CHARS = 4000
export type Levels = Record<Dimension, number>
export type Distributions = Record<Dimension, Record<string, number>>
export type JevReason = Off | JevFailureReason
export type Source = 'jev' | 'default'
/**
 * The routed pair with what led to it: the table's raw cell, whether the role floor lifted it, the chosen levels, the
 * highest probability of each dimension's distribution (`top`, the model's confidence), the normalized distributions
 * themselves (`dist`) and the Jev latency when it was asked.
 */
export type Choice = Pair & { source: Source; jevAsked: boolean; levels: Levels | null; top: Levels | null; dist: Distributions | null; cell: Pair | null; floorApplied: boolean; jevReason: JevReason | null; jevMs: number | null }

const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function normalize(probs: unknown, options: readonly string[]): Record<string, number> {
  if (!record(probs)) throw new JevFailure('malformed', 'missing probabilities')
  let total = 0
  for (const [option, p] of Object.entries(probs)) {
    if (!options.includes(option) || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new JevFailure('malformed', 'invalid probabilities')
    total += p
  }
  if (total <= 0) throw new JevFailure('malformed', 'empty probabilities')
  return Object.fromEntries(options.map(option => [option, (probs[option] as number | undefined ?? 0) / total]))
}

/** Each dimension must carry valid probabilities. */
export function distributions(answers: Answers): Distributions {
  const out = {} as Distributions
  for (const dim of DIMENSIONS) {
    const options = QUESTIONS[dim].criteria.map((_, i) => String(i))
    out[dim] = normalize(answers[dim]?.probabilities, options)
  }
  return out
}

/**
 * The level with the lowest expected penalty, with the router's weights for under- and over-capacity; ties go to the lower
 * level. Costs are rounded before comparing, so a non-integer weight's float error cannot break a tie.
 */
export function levelOf(dist: Record<string, number>): number {
  const levels = Object.keys(dist).map(Number).sort((a, b) => a - b)
  let best = levels[0]!, lowest = Infinity
  for (const c of levels) {
    const cost = round(Object.entries(dist).reduce((sum, [l, p]) => sum + p * (POLICY.under * Math.max(0, Number(l) - c) + POLICY.over * Math.max(0, c - Number(l))), 0))
    if (cost < lowest) { best = c; lowest = cost }
  }
  return best
}

export type EffortIo = KeyIo & { jev: JevIo; breaker: Breaker; gate: Gate; log: (text: string) => void }

/** Jev rates difficulty and duration and the router table picks the pair; any failure keeps the role default. */
export async function assessRoute(io: EffortIo, call: { role: Role; task: string; key?: string; home: string; root: string }): Promise<Choice> {
  let jevAsked = false, startedAt: number | null = null
  const elapsed = () => { try { return jevAsked && startedAt !== null ? Math.max(0, io.jev.now() - startedAt) : null } catch { return null } }
  const fallback = (jevReason: JevReason): Choice => {
    try { io.log(`spider-team: Jev off (${jevReason}); using role default`) } catch { /* Logging cannot change the role fallback. */ }
    return { ...defaultOf(call.role), source: 'default', jevAsked, levels: null, top: null, dist: null, cell: null, floorApplied: false, jevReason, jevMs: elapsed() }
  }
  try {
    const access = await resolveAccess(io, call.key)
    if (access.key === undefined) return fallback(access.off)
    const redacted = redact(call.task.split(access.key).join(REDACTED), { home: call.home, root: call.root })
    const state = redacted.length <= TASK_CHARS ? redacted : head(redacted, TASK_CHARS - 1)
    const jev = { ...io.jev, fetch: (url: string, init: Parameters<JevIo['fetch']>[1]) => { if (!jevAsked) startedAt = io.jev.now(); jevAsked = true; return io.jev.fetch(url, init) } }
    const { answers } = await createJev(jev, access.key, { model: JEV_MODEL, breaker: io.breaker, gate: io.gate, answerIds: Object.keys(QUESTIONS) })(QUESTIONS, state)
    const dists = distributions(answers)
    const levels = { difficulty: levelOf(dists.difficulty), duration: levelOf(dists.duration) }
    const top = { difficulty: Math.max(...Object.values(dists.difficulty)), duration: Math.max(...Object.values(dists.duration)) }
    const routed = routeOf(call.role, levels.difficulty, levels.duration)
    return { ...routed.pair, source: 'jev', jevAsked, levels, top, dist: { difficulty: dists.difficulty, duration: dists.duration }, cell: routed.cell, floorApplied: routed.floorApplied, jevReason: null, jevMs: elapsed() }
  } catch (error) { return fallback(classifyFailure(error).failure.reason) }
}
