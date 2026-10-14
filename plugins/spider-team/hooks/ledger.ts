// Local routing telemetry. Pure: record builders, the summarizer for /spider-team-stats and an append over injected file
// access. A line holds ids, the roles, the pair, levels, probabilities, counts and a reviewer's verdict word; never the task,
// the prompt, an answer, a path, a branch name or a key. Every field is projected one by one, so extra input cannot leak in.
import type { Distributions, Levels, Source } from './effort'
import { DIFFICULTIES, DIMENSIONS, GROUP_OF_DURATION, LADDER, PRICES } from './router'
import type { Dimension, DurationGroup } from './router'
import { MODELS, ROLES } from './roles'
import type { Effort, Model, Pair, Role } from './roles'

export const LEDGER_FILE = '.claude/spider-team/routes.jsonl'
/** Under the host's 4 MiB read limit: past this the current file moves to the one rotated generation. */
export const ROTATE_AT = 2_000_000
export const VERDICTS = ['APPROVED', 'CHANGES', 'BLOCKED'] as const
export type Verdict = (typeof VERDICTS)[number]
export const STATUSES = ['completed', 'error', 'aborted', 'refusal'] as const
export type Status = (typeof STATUSES)[number]
export type Tokens = { input: number; output: number; cacheCreation: number; cacheRead: number }

export type DecisionLine = {
  v: 1; kind: 'decision'; ts: string; tool_use_id: string | null; role: Role; source: Source; jevReason: string | null; jevMs: number | null
  levels: Levels | null; top: Levels | null; dist: Distributions | null; cell: string | null; floorApplied: boolean; model: Model; effort: Effort
}
export type OutcomeLine = {
  v: 1; kind: 'outcome'; ts: string; tool_use_id: string | null; role: Role; model: Model; effort: Effort; mode: 'foreground' | 'background'
  resolvedModel: string | null; modelsUsed: number | null; status: Status; aborted: boolean; durationMs: number | null
  tokens: Tokens | null; costUsd: number | null; verdict: Verdict | null
}
export type Line = DecisionLine | OutcomeLine

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
const maybeCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
const round = (n: number, places: number) => { const k = 10 ** places; return Math.round(n * k) / k }
const word = (value: unknown, max: number) => typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value) && value.length <= max ? value : null
const pairText = (pair: Pair) => `${pair.model}/${pair.effort}`

/** The number of levels each dimension's question has: its distribution's keys are "0" up to one less. */
const LEVEL_COUNT: Readonly<Record<Dimension, number>> = { difficulty: DIFFICULTIES.length, duration: GROUP_OF_DURATION.length }
/** One distribution, key by key: only the dimension's level keys, each a finite probability rounded to two decimals. */
function distOf(dim: Dimension, probs: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!record(probs)) return out
  for (let level = 0; level < LEVEL_COUNT[dim]; level++) {
    const p = probs[String(level)]
    if (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1) out[String(level)] = round(p, 2)
  }
  return out
}

export type DecisionInput = { ts: string; toolUseId: string | undefined; role: Role; choice: { source: Source; jevReason: string | null; jevMs: number | null; levels: Levels | null; top: Levels | null; dist: Distributions | null; cell: Pair | null; floorApplied: boolean; model: Model; effort: Effort } }
export function decisionLine({ ts, toolUseId, role, choice }: DecisionInput): DecisionLine {
  const levels = choice.levels && { difficulty: choice.levels.difficulty, duration: choice.levels.duration }
  const top = choice.top && { difficulty: round(choice.top.difficulty, 2), duration: round(choice.top.duration, 2) }
  const probs = choice.dist
  const dist = probs && Object.fromEntries(DIMENSIONS.map(dim => [dim, distOf(dim, probs[dim])])) as Distributions
  return {
    v: 1, kind: 'decision', ts, tool_use_id: word(toolUseId, 80), role, source: choice.source, jevReason: word(choice.jevReason, 40), jevMs: maybeCount(choice.jevMs),
    levels, top, dist, cell: choice.cell && pairText(choice.cell), floorApplied: choice.floorApplied, model: choice.model, effort: choice.effort,
  }
}

/** The reviewer's verdict word, nothing else of the answer: the last `verdict: WORD`, else the one verdict word the text holds. */
export function verdictOf(text: string): Verdict | null {
  let last: Verdict | null = null
  for (const m of text.matchAll(/\bverdict\W{0,6}(APPROVED|CHANGES|BLOCKED)\b/gi)) last = m[1]!.toUpperCase() as Verdict
  if (last) return last
  const found = VERDICTS.filter(v => new RegExp(`\\b${v}\\b`).test(text))
  return found.length === 1 ? found[0]! : null
}

export function modelFamily(id: string | null): Model | null {
  const lower = (id ?? '').toLowerCase()
  return MODELS.find(model => lower.includes(model)) ?? null
}
/** Estimated USD from the list prices in `PRICES`; the model is the resolved id's family, else the routed one. */
export function costOf(model: Model | null, tokens: Tokens): number | null {
  if (!model) return null
  const p = PRICES[model]
  return round((tokens.input * p.input + tokens.output * p.output + tokens.cacheCreation * p.cacheWrite + tokens.cacheRead * p.cacheRead) / 1_000_000, 6)
}

export type Pending = { toolUseId: string | undefined; role: Role; pair: Pair }
/** A foreground call's context: the decision it came from. */
export type Context = Pending

function outcome(ctx: Context, ts: string, mode: OutcomeLine['mode'], fields: { resolvedModel: unknown; modelsUsed: unknown; status: Status; aborted: boolean; durationMs: unknown; tokens: Tokens | null; text: string }): OutcomeLine {
  const resolvedModel = word(fields.resolvedModel, 80)
  return {
    v: 1, kind: 'outcome', ts, tool_use_id: word(ctx.toolUseId, 80), role: ctx.role, model: ctx.pair.model, effort: ctx.pair.effort, mode,
    resolvedModel, modelsUsed: Array.isArray(fields.modelsUsed) ? fields.modelsUsed.length : null, status: fields.status, aborted: fields.aborted,
    durationMs: maybeCount(fields.durationMs), tokens: fields.tokens, costUsd: fields.tokens && costOf(modelFamily(resolvedModel) ?? ctx.pair.model, fields.tokens),
    verdict: ctx.role === 'reviewer' ? verdictOf(fields.text) : null,
  }
}
const tokensOf = (usage: unknown): Tokens | null => record(usage)
  ? { input: count(usage.input_tokens), output: count(usage.output_tokens), cacheCreation: count(usage.cache_creation_input_tokens), cacheRead: count(usage.cache_read_input_tokens) } : null
const textOf = (r: Record<string, unknown>): string => {
  const parts = Array.isArray(r.content) ? r.content.filter(record).map(c => typeof c.text === 'string' ? c.text : '') : []
  const report = record(r.handbackReport) && typeof r.handbackReport.text === 'string' ? r.handbackReport.text : ''
  return parts.join('\n') || report
}

/**
 * What the `Agent` call returned: a finished foreground run is an outcome line, a background launch the agent id to
 * wait for, a refusal or anything unrecognized nothing.
 */
export function afterAgentCall(ctx: Context, result: unknown, ts: string): { line: OutcomeLine } | { launched: string } | null {
  if (!record(result) || typeof result.deny === 'string') return null
  if (result.isError === true) return { line: outcome(ctx, ts, 'foreground', { resolvedModel: null, modelsUsed: null, status: 'error', aborted: false, durationMs: null, tokens: null, text: '' }) }
  const r = result.result
  if (!record(r)) return null
  if (r.status === 'async_launched') return typeof r.agentId === 'string' && r.agentId ? { launched: r.agentId } : null
  if (r.status !== 'completed') return null
  return { line: outcome(ctx, ts, 'foreground', { resolvedModel: r.resolvedModel, modelsUsed: r.modelsUsed, status: 'completed', aborted: false, durationMs: r.totalDurationMs, tokens: tokensOf(r.usage), text: textOf(r) }) }
}

export type TurnEnd = { answer: string; durationMs: number; isAborted: boolean; reason: string; usage?: { model: string; input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } }
/** A background agent's end: its `turn.complete`. The answer is read for a reviewer's verdict and dropped. */
export function afterTurn(ctx: Context, turn: TurnEnd, ts: string): OutcomeLine {
  const status: Status = turn.isAborted || turn.reason === 'aborted' ? 'aborted' : turn.reason === 'error' ? 'error' : turn.reason === 'refusal' ? 'refusal' : 'completed'
  return outcome(ctx, ts, 'background', { resolvedModel: turn.usage?.model ?? null, modelsUsed: null, status, aborted: status === 'aborted', durationMs: turn.durationMs, tokens: tokensOf(turn.usage), text: typeof turn.answer === 'string' ? turn.answer : '' })
}

/** Background agents waiting for their `turn.complete`, oldest dropped past the limit. */
export function createPending(limit = 200) {
  const map = new Map<string, Pending>()
  return {
    add(agentId: string, pending: Pending) {
      map.delete(agentId); map.set(agentId, pending)
      while (map.size > limit) map.delete(map.keys().next().value as string)
    },
    take(agentId: string): Pending | undefined { const pending = map.get(agentId); map.delete(agentId); return pending },
    get size() { return map.size },
  }
}

export type FileIo = { exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string>; write: (path: string, text: string) => Promise<void> }
export const rotatedPath = (path: string) => path.replace(/\.jsonl$/, '.1.jsonl')
export const ledgerPath = (home: string) => `${home.replace(/\/+$/, '')}/${LEDGER_FILE}`

// Every append of this process goes through one queue: the host writes whole files, so two at once would lose a line.
let tail: Promise<unknown> = Promise.resolve()
async function add(io: FileIo, path: string, line: Line) {
  const text = JSON.stringify(line) + '\n'
  let current = await io.exists(path) ? await io.read(path) : ''
  if (current && !current.endsWith('\n')) current += '\n'
  if (current.length + text.length > ROTATE_AT) { await io.write(rotatedPath(path), current); current = '' }
  await io.write(path, current + text)
}
/**
 * Appends one JSON line (read, then write the whole file). A file that cannot be read is never overwritten: the append
 * rejects instead. Past `ROTATE_AT` the file moves to its one rotated generation first.
 */
export function appendLine(io: FileIo, path: string, line: Line): Promise<void> {
  const run = tail.then(() => add(io, path, line))
  tail = run.catch(() => undefined)
  return run
}
/** The rotated generation then the current file, as one text. */
export async function readAll(io: FileIo, path: string): Promise<string> {
  const texts: string[] = []
  for (const file of [rotatedPath(path), path]) if (await io.exists(file)) texts.push(await io.read(file))
  return texts.join('\n')
}

/** Parses ledger text, oldest first; lines that are not a known record are skipped, repeated lines count once. */
export function parseLedger(text: string): Line[] {
  const out: Line[] = [], seen = new Set<string>()
  for (const raw of text.split('\n')) {
    if (!raw.trim() || seen.has(raw)) continue
    seen.add(raw)
    let value: unknown
    try { value = JSON.parse(raw) } catch { continue }
    if (!record(value) || value.v !== 1 || !ROLES.includes(value.role as Role) || !MODELS.includes(value.model as Model) || typeof value.effort !== 'string') continue
    if (value.kind === 'decision' || value.kind === 'outcome') out.push(value as unknown as Line)
  }
  return out
}

export type Group = { count: number; failures: number; medianMs: number | null; tokens: number; costUsd: number }
export type Summary = {
  decisions: number; outcomes: number
  byRole: { key: string; group: Group }[]; byPair: { key: string; group: Group }[]
  fallback: { count: number; reasons: Record<string, number> }
  confidence: Record<'difficulty' | 'duration', { count: number; median: number | null; buckets: [number, number, number, number] }>
  durationCheck: { compared: number; hits: number; matrix: Record<DurationGroup, Record<DurationGroup, number>> }
}
const BUCKET_EDGES = [0.5, 0.7, 0.9] as const
const median = (values: number[]) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1
  return round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2, 6)
}
/** A failed run: it errored or was aborted or refused, or its reviewer asked for CHANGES or blocked. */
export const failed = (line: OutcomeLine) => line.status !== 'completed' || line.aborted || line.verdict === 'CHANGES' || line.verdict === 'BLOCKED'
const SHORT_MS = 10 * 60_000, MEDIUM_MS = 30 * 60_000
/** The real duration bucket: under 10 minutes short, 10 to 30 medium, over 30 long. */
export const bucketOf = (ms: number): DurationGroup => ms < SHORT_MS ? 'short' : ms <= MEDIUM_MS ? 'medium' : 'long'

export function summarize(lines: Line[]): Summary {
  const decisions = lines.filter((l): l is DecisionLine => l.kind === 'decision'), outcomes = lines.filter((l): l is OutcomeLine => l.kind === 'outcome')
  const group = (items: OutcomeLine[]): Group => ({
    count: items.length, failures: items.filter(failed).length, medianMs: median(items.flatMap(i => i.durationMs === null ? [] : [i.durationMs])),
    tokens: items.reduce((n, i) => n + (i.tokens ? i.tokens.input + i.tokens.output + i.tokens.cacheCreation + i.tokens.cacheRead : 0), 0),
    costUsd: round(items.reduce((n, i) => n + (i.costUsd ?? 0), 0), 6),
  })
  const keyed = (key: (l: OutcomeLine) => string, order: string[]) => {
    const map = new Map<string, OutcomeLine[]>()
    for (const l of outcomes) map.set(key(l), [...map.get(key(l)) ?? [], l])
    return [...map].sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b)).map(([k, items]) => ({ key: k, group: group(items) }))
  }
  const reasons: Record<string, number> = {}
  const defaults = decisions.filter(d => d.source === 'default')
  for (const d of defaults) { const reason = word(d.jevReason, 40) ?? 'unknown'; reasons[reason] = (reasons[reason] ?? 0) + 1 }
  const confidence = {} as Summary['confidence']
  for (const dim of ['difficulty', 'duration'] as const) {
    const tops = decisions.flatMap(d => d.top && typeof d.top[dim] === 'number' ? [d.top[dim]] : [])
    const buckets: [number, number, number, number] = [0, 0, 0, 0]
    for (const t of tops) buckets[t < BUCKET_EDGES[0] ? 0 : t < BUCKET_EDGES[1] ? 1 : t < BUCKET_EDGES[2] ? 2 : 3]++
    confidence[dim] = { count: tops.length, median: median(tops), buckets }
  }
  const matrix = Object.fromEntries((['short', 'medium', 'long'] as const).map(p => [p, { short: 0, medium: 0, long: 0 }])) as Summary['durationCheck']['matrix']
  const byId = new Map(decisions.flatMap(d => d.tool_use_id && d.levels ? [[d.tool_use_id, d] as const] : []))
  let compared = 0, hits = 0
  for (const o of outcomes) {
    const d = o.tool_use_id ? byId.get(o.tool_use_id) : undefined
    const predicted = d?.levels ? GROUP_OF_DURATION[d.levels.duration] : undefined
    if (!predicted || o.durationMs === null) continue
    const actual = bucketOf(o.durationMs)
    matrix[predicted][actual]++; compared++; if (predicted === actual) hits++
  }
  return {
    decisions: decisions.length, outcomes: outcomes.length,
    byRole: keyed(l => l.role, [...ROLES]), byPair: keyed(l => `${l.model}/${l.effort}`, [...LADDER]),
    fallback: { count: defaults.length, reasons }, confidence, durationCheck: { compared, hits, matrix },
  }
}

const pct = (n: number, total: number) => total ? `${Math.round(100 * n / total)}%` : '-'
const span = (ms: number | null) => ms === null ? '-' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${round(ms / 1000, 1)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${round(ms / 3_600_000, 1)}h`
const tokensText = (n: number) => n < 1000 ? String(n) : n < 1_000_000 ? `${round(n / 1000, 1)}k` : `${round(n / 1_000_000, 2)}M`
const row = (name: string, g: Group) => `  ${name.padEnd(16)} n=${g.count} fail=${pct(g.failures, g.count)} median=${span(g.medianMs)} tokens=${tokensText(g.tokens)} cost=$${g.costUsd.toFixed(4)}`

export function formatSummary(s: Summary): string {
  // The host prefixes command output with the plugin name, so these texts do not repeat it.
  if (!s.decisions && !s.outcomes) return 'no routing records yet in ~/.claude/spider-team/routes.jsonl.'
  const out = [`${s.decisions} decisions, ${s.outcomes} outcomes (~/.claude/spider-team/routes.jsonl; cost is an estimate from list prices)`]
  out.push('By role', ...(s.byRole.length ? s.byRole.map(r => row(r.key, r.group)) : ['  no outcomes yet']))
  out.push('By final pair', ...(s.byPair.length ? s.byPair.map(r => row(r.key, r.group)) : ['  no outcomes yet']))
  const reasons = Object.entries(s.fallback.reasons).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(', ')
  out.push(`Default fallbacks: ${s.fallback.count} of ${s.decisions} (${pct(s.fallback.count, s.decisions)})${reasons ? `: ${reasons}` : ''}`)
  out.push('Jev top confidence (<0.5 / 0.5-0.7 / 0.7-0.9 / 0.9+)')
  for (const dim of ['difficulty', 'duration'] as const) {
    const c = s.confidence[dim]
    out.push(`  ${dim.padEnd(10)} n=${c.count} median=${c.median === null ? '-' : c.median.toFixed(2)} [${c.buckets.join(' / ')}]`)
  }
  const d = s.durationCheck
  out.push(`Duration check, predicted group vs real (short <10m, medium 10-30m, long >30m): ${d.hits} of ${d.compared} in the predicted group (${pct(d.hits, d.compared)})`)
  for (const p of ['short', 'medium', 'long'] as const) out.push(`  predicted ${p.padEnd(6)} -> short ${d.matrix[p].short}, medium ${d.matrix[p].medium}, long ${d.matrix[p].long}`)
  return out.join('\n')
}
