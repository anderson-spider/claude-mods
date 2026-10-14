// Pure effort assessment and selection. Host access is injected; only redacted task text leaves the machine.
import { classifyFailure, createJev, JevFailure } from './jev'
import type { Answers, Breaker, Gate, JevFailureReason, JevIo } from './jev'
import { resolveAccess } from './key'
import type { KeyIo, Off } from './key'
import { head, redact, REDACTED } from './redact'
import { SPECS } from './roles'
import type { Effort, Role } from './roles'

export const JEV_MODEL = 'jev-1.13.0'
export const TASK_CHARS = 4000
export const DIMENSIONS = ['difficulty', 'duration', 'scope'] as const
export type Dimension = (typeof DIMENSIONS)[number]
export type Levels = Record<Dimension, number>
export type Distributions = Record<Dimension, Record<string, number>>
export type JevReason = Off | JevFailureReason
export type EffortChoice = {
  effort: Effort
  source: 'jev' | 'default' | 'pinned'
  jevModel: typeof JEV_MODEL
  expected: Levels | null
  jevReason: JevReason | null
}

// Criteria, points and asymmetric penalty follow herdr-router's config/policy.default.json and router/score.py.
// Sol's policy omits scope: here its medium/high/xhigh targets are 1/2/3 (component/related files/codebase).
// No cost/time penalty is added: the requested score dimensions decide, with cheaper effort breaking ties.
export const POLICY = {
  under: 4.0, over: 0.5, tolerance: 0.5,
  weights: { difficulty: 1.0, duration: 1.0, scope: 0.5 },
  candidates: {
    sol: [
      { effort: 'medium', point: { difficulty: 2.57, duration: 0.9, scope: 1 } },
      { effort: 'high', point: { difficulty: 2.86, duration: 1.5, scope: 2 } },
      { effort: 'xhigh', point: { difficulty: 3.0, duration: 2.2, scope: 3 } },
    ],
    luna: [
      { effort: 'low', point: { difficulty: 0.0, duration: 0.3, scope: 0.5 } },
      { effort: 'medium', point: { difficulty: 0.0, duration: 0.9, scope: 0.5 } },
      { effort: 'high', point: { difficulty: 0.43, duration: 1.5, scope: 0.5 } },
    ],
  },
} as const

export const QUESTIONS = {
  difficulty: {
    type: 'score', instructions: 'How hard is this task for a capable coding agent?',
    criteria: [
      'Trivial: a one-line or purely mechanical change',
      'Easy: small, well-understood change in one place',
      'Moderate: needs some understanding of the surrounding code',
      'Hard: subtle logic, several interacting parts, or unclear root cause',
      'Expert: architecture, concurrency, security, or deep domain reasoning',
    ],
  },
  duration: {
    type: 'score', instructions: 'How long will a coding agent need to finish this task?',
    criteria: ['Under 5 minutes', '5 to 30 minutes', '30 to 120 minutes', 'Several hours or more'],
  },
  scope: {
    type: 'score', instructions: 'How much of the codebase does this task touch?',
    criteria: ['One spot in one file', 'One file or one small component', 'Several related files', 'Many files across the codebase'],
  },
} as const

/** Reject missing dimensions, unknown levels, non-numbers and zero mass; normalize finite nonnegative probabilities. */
export function distributions(answers: Answers): Distributions {
  const out = {} as Distributions
  for (const dim of DIMENSIONS) {
    const probs = answers[dim]?.probabilities
    if (!probs || typeof probs !== 'object' || Array.isArray(probs)) throw new JevFailure('malformed', 'missing probabilities')
    const entries = Object.entries(probs)
    let total = 0
    for (const [level, p] of entries) {
      if (!/^[0-4]$/.test(level) || Number(level) >= QUESTIONS[dim].criteria.length || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
        throw new JevFailure('malformed', 'invalid probabilities')
      }
      total += p
    }
    if (total <= 0) throw new JevFailure('malformed', 'empty probabilities')
    out[dim] = Object.fromEntries(entries.map(([level, p]) => [level, (p as number) / total]))
  }
  return out
}

/** Expected penalty across each full distribution, rather than penalty at its mean. */
export function penalty(point: Levels, dists: Distributions): number {
  const { under, over, tolerance, weights } = POLICY
  const round = (n: number) => Math.round(n * 10_000) / 10_000
  return round(DIMENSIONS.reduce((sum, dim) => sum + round(weights[dim] * Object.entries(dists[dim]).reduce((pen, [level, p]) =>
    pen + p * (under * Math.max(0, Number(level) - point[dim] - tolerance) + over * Math.max(0, point[dim] - Number(level) - tolerance)), 0)), 0))
}

export function choose(role: Exclude<Role, 'reviewer'>, dists: Distributions): Effort {
  const candidates = POLICY.candidates[role === 'analyst' ? 'luna' : 'sol']
  let best: Effort = candidates[0].effort
  let lowest = Infinity
  for (const candidate of candidates) {
    const score = penalty(candidate.point, dists)
    // Candidates are ordered by price: keeping the first equal score breaks ties toward the cheaper effort.
    if (score < lowest) { lowest = score; best = candidate.effort }
  }
  return best
}

export type EffortIo = KeyIo & { jev: JevIo; breaker: Breaker; gate: Gate; log: (text: string) => void }

export async function assessEffort(io: EffortIo, call: { role: Exclude<Role, 'reviewer'>; task: string; key?: string; home: string; root: string; pinned?: Effort }): Promise<EffortChoice> {
  const base = { jevModel: JEV_MODEL, expected: null, jevReason: null } as const
  if (call.pinned !== undefined) return { ...base, effort: call.pinned, source: 'pinned' }
  const fallback = (jevReason: JevReason): EffortChoice => {
    io.log(`codex-team: Jev off (${jevReason}); using role default`)
    return { ...base, effort: SPECS[call.role].effort, source: 'default', jevReason }
  }
  const access = await resolveAccess(io, call.key)
  if (access.key === undefined) return fallback(access.off)
  try {
    // Remove this exact credential too, including a key with no recognizable prefix. Redact before truncating.
    const redacted = redact(call.task.split(access.key).join(REDACTED), { home: call.home, root: call.root })
    const state = redacted.length <= TASK_CHARS ? redacted : head(redacted, TASK_CHARS - 1)
    const reply = await createJev(io.jev, access.key, { model: JEV_MODEL, breaker: io.breaker, gate: io.gate })(QUESTIONS, state)
    const dists = distributions(reply.answers)
    const expected = Object.fromEntries(DIMENSIONS.map(dim => [dim, Math.round(Object.entries(dists[dim]).reduce((sum, [level, p]) => sum + Number(level) * p, 0) * 10) / 10])) as Levels
    return { ...base, effort: choose(call.role, dists), source: 'jev', expected }
  } catch (error) {
    return fallback(classifyFailure(error).failure.reason)
  }
}
