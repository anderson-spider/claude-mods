// Routing policy and assessment. Host access is injected; only cleaned, redacted task text leaves the machine.
import { classifyFailure, createJev, JevFailure } from './jev'
import type { Answers, Breaker, Gate, JevFailureReason, JevIo } from './jev'
import { resolveAccess } from './key'
import type { KeyIo, Off } from './key'
import { head, redact, REDACTED } from './redact'
import { routeOf } from './router'
import { EFFORTS, MODELS, SPECS } from './roles'
import type { Effort, Model, Pair, Role } from './roles'

export const JEV_MODEL = 'jev-1.13.0'
export const TASK_CHARS = 4000
export const DIMENSIONS = ['difficulty', 'duration'] as const
export type Dimension = (typeof DIMENSIONS)[number]
export type Levels = Record<Dimension, number>
export type DimensionPins = Partial<Levels>
export type Pins = { model?: Model; effort?: Effort; dimensions: DimensionPins }
export type Distributions = Record<Dimension, Record<string, number>>
export type JevReason = Off | JevFailureReason
export type Source = 'jev' | 'default' | 'pinned' | 'override'
export type Choice = Pair & { source: Source; jevAsked: boolean; levels: Levels | null; jevReason: JevReason | null }

// Policy, not a measurement: a task that needs more than the pair gives costs twice what spare capacity does.
export const POLICY = { under: 2, over: 1 } as const
export const QUESTIONS = {
  difficulty: {
    type: 'score', instructions: 'How hard is this task for a capable coding agent?',
    criteria: ['Trivial: a one-line or purely mechanical change', 'Easy: small, well-understood change in one place', 'Moderate: needs some understanding of the surrounding code', 'Hard: subtle logic, several interacting parts, or unclear root cause', 'Expert: architecture, concurrency, security, or deep domain reasoning'],
  },
  duration: {
    type: 'score', instructions: 'How long will a coding agent need to finish this task?',
    criteria: ['Under 5 minutes', '5 to 30 minutes', '30 to 120 minutes', 'Several hours or more'],
  },
} as const

export const INVALID_PINS = 'invalid pins'
function invalid(): never { throw new Error(INVALID_PINS) }

/** Complete whitespace-delimited bang directives only; preserve every other byte, including escaped markers. */
export function parsePins(task: string, fields: { model?: unknown; effort?: unknown } = {}): { task: string; pins: Pins } {
  if (fields.model !== undefined && !MODELS.includes(fields.model as Model)) invalid()
  if (fields.effort !== undefined && !EFFORTS.includes(fields.effort as Effort)) invalid()
  const pins: Pins = { dimensions: {} }
  if (fields.model !== undefined) pins.model = fields.model as Model
  if (fields.effort !== undefined) pins.effort = fields.effort as Effort
  const ranges: [number, number][] = []
  let fence: { marker: string; length: number } | undefined
  let tick = 0, quote = ''
  const set = (dim: Dimension, value: number) => {
    if (pins.dimensions[dim] !== undefined && pins.dimensions[dim] !== value) invalid()
    pins.dimensions[dim] = value
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
    if (ch === '!' && (i === 0 || /\s/.test(task[i - 1]!))) {
      let end = i + 1
      while (end < task.length && !/\s/.test(task[end]!)) end++
      const token = task.slice(i, end)
      const alias: Record<string, string> = { '!hard': '!difficulty=3', '!long': '!duration=3', '!quick': '!duration=0' }
      const match = (alias[token] ?? token).match(/^!(difficulty|duration)=([^=]+)$/)
      if (!match) invalid()
      const dim = match[1] as Dimension, value = match[2]!
      if (!/^[0-4]$/.test(value) || Number(value) >= QUESTIONS[dim].criteria.length) invalid()
      set(dim, Number(value))
      ranges.push([i, end]); i = end; continue
    }
    i++
  }
  let cleaned = '', from = 0
  for (const [start, end] of ranges) { cleaned += task.slice(from, start); from = end }
  cleaned += task.slice(from)
  return { task: cleaned, pins }
}

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

/** A pinned dimension is certain; any other must carry valid probabilities. */
export function distributions(answers: Answers, pins: DimensionPins = {}): Distributions {
  const out = {} as Distributions
  for (const dim of DIMENSIONS) {
    const options = QUESTIONS[dim].criteria.map((_, i) => String(i))
    out[dim] = normalize(pins[dim] === undefined ? answers[dim]?.probabilities : { [pins[dim]!]: 1 }, options)
  }
  return out
}

/** The level with the lowest expected penalty, under-capacity weighted twice over-capacity; ties go to the lower level. */
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

/** Pins are independent levers: both pinned skips Jev; otherwise Jev is asked only for the dimensions not pinned, and a pinned lever keeps its pin. */
export async function assessRoute(io: EffortIo, call: { role: Role; task: string; key?: string; home: string; root: string; pins: Pins }): Promise<Choice> {
  const { pins } = call
  const spec = SPECS[call.role]
  const choice = (pair: Partial<Pair>, fallback: Pair, source: Source, rest: Partial<Choice> = {}): Choice =>
    ({ model: pins.model ?? pair.model ?? fallback.model, effort: pins.effort ?? pair.effort ?? fallback.effort, source, jevAsked: false, levels: null, jevReason: null, ...rest })
  const role: Pair = { model: spec.model, effort: spec.effort }
  if (pins.model !== undefined && pins.effort !== undefined) return choice({}, role, 'pinned')
  const local = DIMENSIONS.every(dim => pins.dimensions[dim] !== undefined)
  let jevAsked = false
  const fallback = (jevReason: JevReason): Choice => {
    try { io.log(`spider-team: Jev off (${jevReason}); using role default`) } catch { /* Logging cannot change the role fallback. */ }
    return choice({}, role, 'default', { jevReason, jevAsked })
  }
  try {
    let answers: Answers = {}
    if (!local) {
      const access = await resolveAccess(io, call.key)
      if (access.key === undefined) return fallback(access.off)
      const redacted = redact(call.task.split(access.key).join(REDACTED), { home: call.home, root: call.root })
      const state = redacted.length <= TASK_CHARS ? redacted : head(redacted, TASK_CHARS - 1)
      const questions = Object.fromEntries(Object.entries(QUESTIONS).filter(([dim]) => pins.dimensions[dim as Dimension] === undefined))
      const jev = { ...io.jev, fetch: (url: string, init: Parameters<JevIo['fetch']>[1]) => { jevAsked = true; return io.jev.fetch(url, init) } }
      answers = (await createJev(jev, access.key, { model: JEV_MODEL, breaker: io.breaker, gate: io.gate, answerIds: Object.keys(questions) })(questions, state)).answers
    }
    const dists = distributions(answers, pins.dimensions)
    const levels = { difficulty: levelOf(dists.difficulty), duration: levelOf(dists.duration) }
    const pair = routeOf(levels.difficulty, levels.duration)
    return choice(pair, pair, local ? 'override' : 'jev', { jevAsked, levels })
  } catch (error) { return fallback(classifyFailure(error).failure.reason) }
}
