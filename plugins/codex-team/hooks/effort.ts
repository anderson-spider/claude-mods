// Profile policy and assessment. Host access is injected; only cleaned, redacted task text leaves the machine.
import { classifyFailure, createJev, JevFailure } from './jev'
import type { Answers, Breaker, Gate, JevFailureReason, JevIo } from './jev'
import { resolveAccess } from './key'
import type { KeyIo, Off } from './key'
import { head, redact, REDACTED } from './redact'
import { EFFORTS, MODELS, SPECS } from './roles'
import type { Effort, Model, ProfilePair, Role } from './roles'

export const JEV_MODEL = 'jev-1.13.0'
export const TASK_CHARS = 4000
export const DIMENSIONS = ['difficulty', 'duration', 'scope'] as const
export const TASK_TYPES = ['implement', 'bugfix', 'refactor', 'review', 'research', 'docs', 'test'] as const
export type Dimension = (typeof DIMENSIONS)[number]
export type TaskType = (typeof TASK_TYPES)[number]
export type Levels = Record<Dimension, number>
export type DimensionPins = Partial<Levels & { task_type: TaskType }>
export type Pins = { model?: Model; effort?: Effort; profileId?: string; dimensions: DimensionPins }
export type Distributions = Record<Dimension, Record<string, number>> & { task_type: Record<TaskType, number> }
export type JevReason = Off | JevFailureReason
export type Profile = ProfilePair & { id: string; point: Levels; rank: number; affinity: Readonly<Record<string, number>> }
export type Source = 'jev' | 'default' | 'pinned' | 'override'
export type Selection = ProfilePair & { profileId: string | null; source: Source; penalty: number | null }
export type ProfileChoice = Selection & {
  jevAsked: boolean
  expected: Levels | null
  taskType: Record<TaskType, number> | null
  taskTypePrior: boolean
  jevReason: JevReason | null
  dimensionsUsed: boolean
}

// Policy priors, not benchmarks or measured prices. Implemented from the described expected-penalty formula.
export const POLICY = { under: 4, over: 0.5, tolerance: 0.5, weights: { difficulty: 1, duration: 1, scope: 0.5, task_type: 0.25 } } as const
const sol = { '*': 1, research: 0.9, docs: 0.9 }
const luna = { '*': 0.8, research: 1, docs: 1 }
export const PROFILES: readonly Profile[] = [
  { id: 'sol-medium', model: 'gpt-6.1-sol', effort: 'medium', point: { difficulty: 2.57, duration: 0.9, scope: 1 }, rank: 4, affinity: sol },
  { id: 'sol-high', model: 'gpt-6.1-sol', effort: 'high', point: { difficulty: 2.86, duration: 1.5, scope: 2 }, rank: 5, affinity: sol },
  { id: 'sol-xhigh', model: 'gpt-6.1-sol', effort: 'xhigh', point: { difficulty: 3, duration: 2.2, scope: 3 }, rank: 6, affinity: sol },
  { id: 'luna-low', model: 'gpt-6-luna', effort: 'low', point: { difficulty: 0, duration: 0.3, scope: 0.5 }, rank: 1, affinity: luna },
  { id: 'luna-medium', model: 'gpt-6-luna', effort: 'medium', point: { difficulty: 0, duration: 0.9, scope: 0.5 }, rank: 2, affinity: luna },
  { id: 'luna-high', model: 'gpt-6-luna', effort: 'high', point: { difficulty: 0.43, duration: 1.5, scope: 0.5 }, rank: 3, affinity: luna },
]
export const QUESTIONS = {
  difficulty: {
    type: 'score', instructions: 'How hard is this task for a capable coding agent?',
    criteria: ['Trivial: a one-line or purely mechanical change', 'Easy: small, well-understood change in one place', 'Moderate: needs some understanding of the surrounding code', 'Hard: subtle logic, several interacting parts, or unclear root cause', 'Expert: architecture, concurrency, security, or deep domain reasoning'],
  },
  duration: {
    type: 'score', instructions: 'How long will a coding agent need to finish this task?',
    criteria: ['Under 5 minutes', '5 to 30 minutes', '30 to 120 minutes', 'Several hours or more'],
  },
  scope: {
    type: 'score', instructions: 'How much of the codebase must be inspected or changed for this task?',
    criteria: ['One spot in one file', 'One file or one small component', 'Several related files', 'Many files across the codebase'],
  },
  task_type: {
    type: 'choice', instructions: 'What is the primary outcome requested by this task?',
    criteria: { implement: 'Add new product behavior', bugfix: 'Correct existing faulty behavior', refactor: 'Restructure code while preserving behavior', review: 'Assess existing work for defects or risks', research: 'Investigate, explain, or design without implementing code', docs: 'Write or update documentation', test: 'Add or repair automated tests' },
  },
} as const

export const INVALID_PINS = 'invalid profile or pins'
function invalid(): never { throw new Error(INVALID_PINS) }

/** Complete whitespace-delimited directives only; preserve every other byte, including escaped markers. */
export function parsePins(task: string, fields: { model?: unknown; effort?: unknown } = {}): { task: string; pins: Pins } {
  if (fields.model !== undefined && !MODELS.includes(fields.model as Model)) invalid()
  if (fields.effort !== undefined && !EFFORTS.includes(fields.effort as Effort)) invalid()
  const pins: Pins = { dimensions: {} }
  if (fields.model !== undefined) pins.model = fields.model as Model
  if (fields.effort !== undefined) pins.effort = fields.effort as Effort
  const ranges: [number, number][] = []
  let fence: { marker: string; length: number } | undefined
  let tick = 0, quote = ''
  const set = (dim: keyof DimensionPins, value: number | TaskType) => {
    if (pins.dimensions[dim] !== undefined && pins.dimensions[dim] !== value) invalid()
    Object.assign(pins.dimensions, { [dim]: value })
  }
  for (let i = 0; i < task.length;) {
    if (i === 0 || task[i - 1] === '\n') {
      const end = task.indexOf('\n', i)
      const stop = end < 0 ? task.length : end
      const line = task.slice(i, stop)
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (fence) {
        if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
        i = stop + 1; continue
      }
      if (!tick && !quote && marker) { fence = { marker: marker[1]![0]!, length: marker[1]!.length }; i = stop + 1; continue }
    }
    const ch = task[i]!
    if (ch === '\\') { i += 2; continue }
    if (quote) { if (ch === quote) quote = ''; i++; continue }
    if (ch === '`') {
      let end = i + 1
      while (task[end] === '`') end++
      const length = end - i
      if (tick === length) tick = 0
      else if (!tick) tick = length
      i = end; continue
    }
    if (tick) { i++; continue }
    if (ch === '"' || (ch === "'" && (i === 0 || /[\s(=:]/.test(task[i - 1]!)))) { quote = ch; i++; continue }
    if ((ch === '@' || ch === '!') && (i === 0 || /\s/.test(task[i - 1]!))) {
      let end = i + 1
      while (end < task.length && !/\s/.test(task[end]!)) end++
      const token = task.slice(i, end)
      if (ch === '@') {
        const profile = PROFILES.find(p => token === `@${p.id}`)
        if (!profile || (pins.profileId && pins.profileId !== profile.id) || (pins.model && pins.model !== profile.model) || (pins.effort && pins.effort !== profile.effort)) invalid()
        pins.profileId = profile.id
      } else {
        const alias: Record<string, string> = { '!hard': '!difficulty=3', '!long': '!duration=3', '!quick': '!duration=0' }
        const match = (alias[token] ?? token).match(/^!(difficulty|duration|scope|task_type)=([^=]+)$/)
        if (!match) invalid()
        const dim = match[1] as keyof DimensionPins, value = match[2]!
        if (dim === 'task_type') {
          if (!TASK_TYPES.includes(value as TaskType)) invalid()
          set(dim, value as TaskType)
        } else {
          if (!/^[0-4]$/.test(value) || Number(value) >= QUESTIONS[dim].criteria.length) invalid()
          set(dim, Number(value))
        }
      }
      ranges.push([i, end]); i = end; continue
    }
    i++
  }
  let cleaned = '', from = 0
  for (const [start, end] of ranges) { cleaned += task.slice(from, start); from = end }
  cleaned += task.slice(from)
  return { task: cleaned, pins }
}

const round = (n: number) => Math.round(n * 10_000) / 10_000
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

/** Omitted choice uses a uniform prior; present malformed choice and missing scores fail closed. */
export function distributions(answers: Answers, pins: DimensionPins = {}): Distributions {
  const out = {} as Distributions
  for (const dim of DIMENSIONS) {
    const options = QUESTIONS[dim].criteria.map((_, i) => String(i))
    out[dim] = normalize(pins[dim] === undefined ? answers[dim]?.probabilities : { [pins[dim]!]: 1 }, options)
  }
  out.task_type = normalize(pins.task_type !== undefined ? { [pins.task_type]: 1 }
    : !Object.hasOwn(answers, 'task_type') ? Object.fromEntries(TASK_TYPES.map(o => [o, 1 / TASK_TYPES.length]))
      : answers.task_type?.probabilities, TASK_TYPES) as Record<TaskType, number>
  return out
}

/** Integrate both distribution tails; round each weighted dimension and then the total. */
export function penalty(profile: Pick<Profile, 'point' | 'affinity'>, dists: Distributions): number {
  const { under, over, tolerance, weights } = POLICY
  const scores = DIMENSIONS.map(dim => round(weights[dim] * Object.entries(dists[dim]).reduce((sum, [level, p]) =>
    sum + p * (under * Math.max(0, Number(level) - profile.point[dim] - tolerance) + over * Math.max(0, profile.point[dim] - Number(level) - tolerance)), 0)))
  const choice = round(weights.task_type * Object.entries(dists.task_type).reduce((sum, [option, p]) => sum + p * (1 - (profile.affinity[option] ?? profile.affinity['*'] ?? 1)), 0))
  return round(scores.reduce((sum, score) => sum + score, choice))
}

/** Stable input order breaks ties only after the rank. Every role uses the same candidates. */
export function choose(dists: Distributions, profiles: readonly Profile[] = PROFILES): { profile: Profile; penalty: number } {
  let best = profiles[0]!, lowest = Infinity
  for (const profile of profiles) {
    const score = penalty(profile, dists)
    if (score < lowest || (score === lowest && profile.rank < best.rank)) { best = profile; lowest = score }
  }
  return { profile: best, penalty: lowest }
}

export type EffortIo = KeyIo & { jev: JevIo; breaker: Breaker; gate: Gate; log: (text: string) => void }
export const emptyAssessment = { jevAsked: false, expected: null, taskType: null, taskTypePrior: false, jevReason: null, dimensionsUsed: false } as const

export async function assessProfile(io: EffortIo, call: { role: Role; task: string; key?: string; home: string; root: string; pins: Pins }): Promise<ProfileChoice> {
  const { pins } = call
  const spec = SPECS[call.role]
  const explicit = pins.profileId ? PROFILES.find(p => p.id === pins.profileId)! : undefined
  if (explicit || pins.model !== undefined || pins.effort !== undefined) {
    const model = explicit?.model ?? pins.model ?? spec.model, effort = explicit?.effort ?? pins.effort ?? spec.effort
    return { ...emptyAssessment, model, effort, profileId: PROFILES.find(p => p.model === model && p.effort === effort)?.id ?? null, source: 'pinned', penalty: null }
  }
  const local = Object.keys(QUESTIONS).every(dim => pins.dimensions[dim as keyof DimensionPins] !== undefined)
  let jevAsked = false
  const fallback = (jevReason: JevReason): ProfileChoice => {
    io.log(`codex-team: Jev off (${jevReason}); using role default`)
    return { ...emptyAssessment, model: spec.model, effort: spec.effort, profileId: null, source: 'default', penalty: null, jevReason, jevAsked }
  }
  try {
    let answers: Answers = {}
    if (!local) {
      const access = await resolveAccess(io, call.key)
      if (access.key === undefined) return fallback(access.off)
      const redacted = redact(call.task.split(access.key).join(REDACTED), { home: call.home, root: call.root })
      const state = redacted.length <= TASK_CHARS ? redacted : head(redacted, TASK_CHARS - 1)
      const questions = Object.fromEntries(Object.entries(QUESTIONS).filter(([dim]) => pins.dimensions[dim as keyof DimensionPins] === undefined))
      const jev = { ...io.jev, fetch: (url: string, init: Parameters<JevIo['fetch']>[1]) => { jevAsked = true; return io.jev.fetch(url, init) } }
      answers = (await createJev(jev, access.key, { model: JEV_MODEL, breaker: io.breaker, gate: io.gate, answerIds: Object.keys(questions) })(questions, state)).answers
    }
    const dists = distributions(answers, pins.dimensions)
    const selected = choose(dists)
    const expected = Object.fromEntries(DIMENSIONS.map(dim => [dim, Math.round(Object.entries(dists[dim]).reduce((sum, [level, p]) => sum + Number(level) * p, 0) * 10) / 10])) as Levels
    return { ...emptyAssessment, model: selected.profile.model, effort: selected.profile.effort, profileId: selected.profile.id, penalty: selected.penalty, source: local ? 'override' : 'jev', jevAsked, expected, taskType: dists.task_type, taskTypePrior: pins.dimensions.task_type === undefined && !Object.hasOwn(answers, 'task_type'), dimensionsUsed: Object.keys(pins.dimensions).length > 0 }
  } catch (error) { return fallback(classifyFailure(error).failure.reason) }
}
