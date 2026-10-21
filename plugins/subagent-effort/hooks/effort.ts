// The routing policy and the assessment: the question Jev answers, how its answer becomes an effort, and the call that
// asks it. Host access is injected; only redacted task text leaves the machine. Any failure picks no effort, so the
// call goes as it came, exactly as without the plugin.
import type { BuiltinToolInputs } from 'claude-code'
import { classifyFailure, createJev, JevFailure } from './jev'
import type { Answers, Breaker, Gate, JevFailureReason, JevIo, JevUsage } from './jev'
import { resolveAccess } from './key'
import type { KeyIo, KeySources, Off } from './key'
import { head, redact, REDACTED } from './redact'

export type Effort = NonNullable<BuiltinToolInputs['Agent']['effort']>
// Tags each decision line so the stats compare Jev only under one policy: bump it whenever QUESTION, EFFORTS or POLICY change.
export const CALIBRATION = 3
export const JEV_MODEL = 'jev-1.13.0'
/**
 * How much of the task Jev reads: its head, where a brief states its goal. Ratings followed the brief's length even when
 * asked to ignore it (long briefs drew high), so the rest is never sent; the ledger keeps the whole length apart.
 */
export const TASK_CHARS = 800
/**
 * USD per million input tokens of a Jev call; output tokens are free. The published rate as of October 2026, from gateway
 * docs rather than a TypeSafe invoice, so the cost it gives is an estimate.
 */
export const JEV_INPUT_USD_PER_MTOK = 0.042
/** The estimated USD cost of one Jev call from the tokens it reported, to nine decimals. */
export const jevCostOf = (usage: JevUsage): number => Math.round(usage.input * JEV_INPUT_USD_PER_MTOK * 1000) / 1_000_000_000

/** The effort of each level of the question, in the order of its criteria. `max` is never picked. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly Effort[]
/** One question; its criteria are the level scale, one per entry of EFFORTS. */
export const QUESTION = {
  reasoning: {
    type: 'score',
    instructions: 'How much reasoning does a capable coding agent need to do this delegated task well? Judge the work itself, not the length or detail of the brief: a long list of constraints, checks or output rules does not make a task harder. Breadth is not depth: asking for a very thorough survey, covering many files or listing many items makes a task longer, not harder; rate the hardest reasoning step the task needs.',
    criteria: [
      'A lookup or mechanical step with a clear answer, such as finding a file or symbol, listing where something is used, reading one function, or running a known command and reporting its output',
      'A bounded investigation or change in one area, such as tracing one call path, summarizing a module, mapping or inventorying the code of one area however thoroughly, or a small edit with its test',
      'Reasoning across several interacting parts or toward a cause still to be found, such as debugging a failure, reviewing a change across several files, or planning a change that must keep existing contracts',
      'Architecture, security, concurrency or deep domain reasoning, such as designing a protocol, auditing a security boundary, or a redesign across modules',
    ],
  },
} as const

// Policy, not a measurement: spending matters more than headroom, so spare effort costs 1.5 times what missing effort
// does, and the higher of two adjacent levels wins only once it holds more than 60% of their weight: a split judgment
// stays on the cheaper level.
export const POLICY = { under: 1, over: 1.5 } as const

export type JevReason = Off | JevFailureReason
/**
 * What routing decided: the effort Jev's answer selects (null when Jev was off or failed), the highest probability of its
 * distribution (`top`, the model's confidence), why Jev was not used, how long it took when asked and the tokens it
 * reported (null when it reported none or failed).
 */
export type Choice = { effort: Effort | null; level: number | null; top: number | null; jevReason: JevReason | null; jevMs: number | null; jevTokens: JevUsage | null }

const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The answer's probabilities over the question's levels, normalized; anything else is malformed. */
export function distribution(answers: Answers): Record<string, number> {
  const probs = answers.reasoning?.probabilities, options = EFFORTS.map((_, i) => String(i))
  if (!record(probs)) throw new JevFailure('malformed', 'missing probabilities')
  let total = 0
  for (const [option, p] of Object.entries(probs)) {
    if (!options.includes(option) || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new JevFailure('malformed', 'invalid probabilities')
    total += p
  }
  if (total <= 0) throw new JevFailure('malformed', 'empty probabilities')
  return Object.fromEntries(options.map(option => [option, (probs[option] as number | undefined ?? 0) / total]))
}

/**
 * The level with the lowest expected penalty under POLICY; ties go to the lower level. Costs are rounded before
 * comparing, so a non-integer weight's float error cannot break a tie.
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

/** Text that leaves for Jev: the key and then everything `redact` masks are removed from the whole text, then it is cut to `TASK_CHARS`. */
export function clipped(text: string, key: string, ctx: { home: string; root: string }): string {
  const redacted = redact(text.split(key).join(REDACTED), { home: ctx.home, root: ctx.root })
  return redacted.length <= TASK_CHARS ? redacted : head(redacted, TASK_CHARS - 1)
}

export type EffortIo = KeyIo & { jev: JevIo; breaker: Breaker; gate: Gate; log: (text: string) => void }

/** Jev rates the task and its level is the effort; any failure is no effort, with the reason. */
export async function assessEffort(io: EffortIo, call: { task: string; keys: KeySources; home: string; root: string }): Promise<Choice> {
  let startedAt: number | null = null
  const elapsed = () => { try { return startedAt !== null ? Math.max(0, io.jev.now() - startedAt) : null } catch { return null } }
  const off = (jevReason: JevReason): Choice => {
    try { io.log(`subagent-effort: Jev off (${jevReason}); the call goes as it came`) } catch { /* Logging cannot change the dispatch. */ }
    return { effort: null, level: null, top: null, jevReason, jevMs: elapsed(), jevTokens: null }
  }
  try {
    const access = await resolveAccess(io, call.keys)
    if (access.key === undefined) return off(access.off)
    const state = clipped(call.task, access.key, call)
    const jev = { ...io.jev, fetch: (url: string, init: Parameters<JevIo['fetch']>[1]) => { startedAt ??= io.jev.now(); return io.jev.fetch(url, init) } }
    const { answers, usage } = await createJev(jev, access.key, { model: JEV_MODEL, breaker: io.breaker, gate: io.gate, answerIds: Object.keys(QUESTION) })(QUESTION, state)
    const dist = distribution(answers), level = levelOf(dist)
    return { effort: EFFORTS[level]!, level, top: Math.max(...Object.values(dist)), jevReason: null, jevMs: elapsed(), jevTokens: usage }
  } catch (error) { return off(classifyFailure(error).failure.reason) }
}
