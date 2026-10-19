// Local routing records. Pure: line builders, the summary for /subagent-effort-stats and an append over injected file
// access. A line holds ids, the agent type, the effort, Jev's confidence, latency, tokens and cost, counts and the brief's length in
// characters; never the task, the prompt, an answer, a path or a key. Every field is projected one by one, so extra
// input cannot leak in.
import { CALIBRATION, EFFORTS, jevCostOf } from './effort'
import type { Choice, Effort } from './effort'

export const LEDGER_FILE = '.claude/subagent-effort/routes.jsonl'
/** Under the host's 4 MiB read limit: past this the current file moves to the one rotated generation. */
export const ROTATE_AT = 2_000_000
/** Who decided the effort: Jev, or nobody because Jev was off or failed and the call went as it came. */
export const SOURCES = ['jev', 'off'] as const
export type Source = (typeof SOURCES)[number]
export const STATUSES = ['completed', 'error', 'aborted', 'refusal'] as const
export type Status = (typeof STATUSES)[number]
const ALL_EFFORTS: readonly Effort[] = [...EFFORTS, 'max']

/**
 * `received` is the effort the call came with, `effort` the one the agent runs with; null is the agent's usual effort. The
 * Jev fields are the routing call's own: its latency, the tokens it reported and their estimated cost, apart from the
 * subagent's duration and tokens on the outcome line.
 */
export type DecisionLine = {
  v: 1; kind: 'decision'; calibration: number; ts: string; tool_use_id: string | null; agentType: string | null; briefChars: number | null
  source: Source; received: Effort | null; effort: Effort | null; level: number | null; top: number | null; jevReason: string | null; jevMs: number | null
  jevTokens: { input: number; output: number } | null; jevCostUsd: number | null
}
export type OutcomeLine = {
  v: 1; kind: 'outcome'; ts: string; tool_use_id: string | null; agentType: string | null; effort: Effort | null; mode: 'foreground' | 'background'
  resolvedModel: string | null; status: Status; durationMs: number | null; tokens: number | null
}
export type Line = DecisionLine | OutcomeLine

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
const maybeCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
const round2 = (n: number) => Math.round(n * 100) / 100
const word = (value: unknown, max: number) => typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value) && value.length <= max ? value : null
const effortOf = (value: unknown): Effort | null => ALL_EFFORTS.includes(value as Effort) ? value as Effort : null

// The two counts, projected one by one, and the estimated cost from them; null without both.
function jevSpend(usage: unknown): Pick<DecisionLine, 'jevTokens' | 'jevCostUsd'> {
  const input = record(usage) ? maybeCount(usage.input) : null, output = record(usage) ? maybeCount(usage.output) : null
  if (input === null || output === null) return { jevTokens: null, jevCostUsd: null }
  return { jevTokens: { input, output }, jevCostUsd: jevCostOf({ input, output }) }
}

export type DecisionInput = { ts: string; toolUseId: string | undefined; agentType: string; briefChars: number; source: Source; received: Effort | null; effort: Effort | null; choice?: Choice }
export function decisionLine({ ts, toolUseId, agentType, briefChars, source, received, effort, choice }: DecisionInput): DecisionLine {
  return {
    v: 1, kind: 'decision', calibration: CALIBRATION, ts, tool_use_id: word(toolUseId, 80), agentType: word(agentType, 80), briefChars: maybeCount(briefChars),
    source, received: effortOf(received), effort: effortOf(effort), level: maybeCount(choice?.level), top: typeof choice?.top === 'number' && Number.isFinite(choice.top) ? round2(choice.top) : null,
    jevReason: word(choice?.jevReason, 40), jevMs: maybeCount(choice?.jevMs), ...jevSpend(choice?.jevTokens),
  }
}

/** Where the session runs when its first surface is one of these apps, which run the main conversation's agents in background. */
const BACKGROUND_APPS: readonly string[] = ['desktop', 'vscode']

/**
 * Whether an `Agent` call runs in background: it asks to (`run_in_background`, true or "true"), or it comes from the main
 * conversation of a session the desktop app or VS Code runs, where the host always does so. A subagent's own call there
 * runs in the foreground unless it asks.
 */
export function runsInBackground(call: { flag: unknown; surfaces: readonly string[]; fromSubagent: boolean }): boolean {
  if (call.flag === true || call.flag === 'true') return true
  return !call.fromSubagent && BACKGROUND_APPS.includes(call.surfaces[0] ?? '')
}

/** What an outcome line needs from its decision; `background` is how the call runs (runsInBackground), `model` what it asked for (null: no model named). */
export type Context = { toolUseId: string | undefined; agentType: string; effort: Effort | null; background: boolean; model: string | null }

function outcome(ctx: Context, ts: string, mode: OutcomeLine['mode'], fields: { resolvedModel: unknown; status: Status; durationMs: unknown; usage: unknown }): OutcomeLine {
  return {
    v: 1, kind: 'outcome', ts, tool_use_id: word(ctx.toolUseId, 80), agentType: word(ctx.agentType, 80), effort: effortOf(ctx.effort), mode,
    resolvedModel: word(fields.resolvedModel, 80), status: fields.status, durationMs: maybeCount(fields.durationMs), tokens: tokensOf(fields.usage),
  }
}
/** Every token a run processed: input, cache written and read, and output. */
const tokensOf = (usage: unknown): number | null => record(usage)
  ? count(usage.input_tokens) + count(usage.output_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens) : null

/** How the host's error text starts when the permission check denied the call, so it never ran. */
const PERMISSION_DENIED = 'Permission for this action was denied'
/**
 * What the `Agent` call returned: a finished foreground run is an outcome line, a background launch the agent id to
 * wait for, a refusal, a permission denial or anything unrecognized nothing.
 */
export function afterAgentCall(ctx: Context, result: unknown, ts: string): OutcomeLine | { launched: string } | null {
  if (!record(result) || typeof result.deny === 'string') return null
  if (result.isError === true && typeof result.text === 'string' && result.text.startsWith(PERMISSION_DENIED)) return null
  if (result.isError === true) return outcome(ctx, ts, ctx.background ? 'background' : 'foreground', { resolvedModel: ctx.model, status: 'error', durationMs: null, usage: null })
  const r = result.result
  if (!record(r)) return null
  if (r.status === 'async_launched') return typeof r.agentId === 'string' && r.agentId ? { launched: r.agentId } : null
  if (r.status !== 'completed') return null
  return outcome(ctx, ts, 'foreground', { resolvedModel: r.resolvedModel ?? ctx.model, status: 'completed', durationMs: r.totalDurationMs, usage: r.usage })
}

export type TurnEnd = { durationMs: number; isAborted: boolean; reason: string; usage?: { model: string } }
/** A background agent's end: its `turn.complete`. */
export function afterTurn(ctx: Context, turn: TurnEnd, ts: string): OutcomeLine {
  const status: Status = turn.isAborted || turn.reason === 'aborted' ? 'aborted' : turn.reason === 'error' ? 'error' : turn.reason === 'refusal' ? 'refusal' : 'completed'
  return outcome(ctx, ts, 'background', { resolvedModel: turn.usage?.model ?? null, status, durationMs: turn.durationMs, usage: turn.usage })
}

/** Background agents waiting for their `turn.complete`, oldest dropped past the limit. */
export function createPending(limit = 200) {
  const map = new Map<string, Context>()
  return {
    add(agentId: string, ctx: Context) {
      map.delete(agentId); map.set(agentId, ctx)
      while (map.size > limit) map.delete(map.keys().next().value as string)
    },
    take(agentId: string): Context | undefined { const ctx = map.get(agentId); map.delete(agentId); return ctx },
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
    if (!record(value) || value.v !== 1 || (value.effort !== null && !effortOf(value.effort))) continue
    if (value.kind === 'decision' && SOURCES.includes(value.source as Source)) out.push(value as unknown as DecisionLine)
    if (value.kind === 'outcome' && STATUSES.includes(value.status as Status)) out.push(value as unknown as OutcomeLine)
  }
  return out
}

/** The model family of a resolved id (`claude-haiku-5-5` is haiku), `?` when unknown. */
export const familyOf = (id: string | null) => ['haiku', 'sonnet', 'opus', 'fable'].find(f => (id ?? '').toLowerCase().includes(f)) ?? '?'
const median = (values: number[]) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export type Group = { key: string; runs: number; failures: number; medianMs: number | null; medianTokens: number | null }
/** `overridden` counts Jev decisions that replaced a different effort the call came with. */
/** The routing calls to Jev, apart from the subagents: how many were asked, their median latency, tokens and estimated cost. */
export type JevSpend = { asked: number; medianMs: number | null; inputTokens: number; outputTokens: number; costUsd: number }
export type Summary = { decisions: number; bySource: Record<Source, number>; overridden: number; offReasons: Record<string, number>; olderCalibration: number; jev: JevSpend; groups: Group[] }
/**
 * Decisions per source, the explicit efforts Jev replaced, why Jev was off and what its calls cost; outcomes grouped by model family and effort (`haiku/low`, `opus/usual` when
 * no effort was set), with failures and the median duration and tokens. Decisions of an older calibration are counted apart.
 */
export function summarize(lines: Line[]): Summary {
  const bySource = { jev: 0, off: 0 } as Record<Source, number>, offReasons: Record<string, number> = {}
  let decisions = 0, olderCalibration = 0, overridden = 0
  const jevMs: number[] = [], jev: JevSpend = { asked: 0, medianMs: null, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  const groups = new Map<string, OutcomeLine[]>()
  for (const line of lines) {
    if (line.kind === 'decision') {
      decisions++
      bySource[line.source]++
      if (line.calibration !== CALIBRATION) olderCalibration++
      if (line.source === 'jev' && line.received && line.received !== line.effort) overridden++
      if (line.jevMs !== null) { jev.asked++; jevMs.push(line.jevMs) }
      if (line.jevTokens) { jev.inputTokens += line.jevTokens.input; jev.outputTokens += line.jevTokens.output; jev.costUsd += line.jevCostUsd ?? 0 }
      if (line.source === 'off') offReasons[line.jevReason ?? '?'] = (offReasons[line.jevReason ?? '?'] ?? 0) + 1
      continue
    }
    const key = `${familyOf(line.resolvedModel)}/${line.effort ?? 'usual'}`
    groups.set(key, [...groups.get(key) ?? [], line])
  }
  return {
    decisions, bySource, overridden, offReasons, olderCalibration, jev: { ...jev, medianMs: median(jevMs), costUsd: Math.round(jev.costUsd * 1e9) / 1e9 },
    groups: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, runs]) => ({
      key, runs: runs.length, failures: runs.filter(r => r.status !== 'completed').length,
      medianMs: median(runs.flatMap(r => r.durationMs ?? [])), medianTokens: median(runs.flatMap(r => r.tokens ?? [])),
    })),
  }
}

const seconds = (ms: number | null) => ms === null ? '?' : `${Math.round(ms / 1000)}s`
/**
 * US dollars with two significant digits after the leading zeros, and never fewer than two decimals: a Jev call costs
 * a few millionths of a dollar, which a fixed number of decimals would show as zero.
 */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0'
  return `$${n.toFixed(Math.max(2, Math.ceil(-Math.log10(n)) + 1))}`
}
const tokens = (n: number | null) => n === null ? '?' : n >= 1_000_000 ? `${round2(n / 1_000_000)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
/** The summary as text, one line per group; the host prefixes the plugin name. */
export function formatSummary(s: Summary): string {
  if (!s.decisions && !s.groups.length) return 'no routing records yet.'
  const off = Object.entries(s.offReasons).map(([reason, n]) => `${reason} ×${n}`).join(', ')
  const head = `${s.decisions} decisions: Jev ${s.bySource.jev}${s.overridden ? ` (${s.overridden} replacing the call's effort)` : ''}, Jev off ${s.bySource.off}${off ? ` (${off})` : ''}${s.olderCalibration ? `; ${s.olderCalibration} from an older calibration` : ''}.`
  const asked = s.jev.asked ? [`Jev calls: ${s.jev.asked}, median ${s.jev.medianMs === null ? '?' : `${Math.round(s.jev.medianMs)}ms`}, ${tokens(s.jev.inputTokens)} input and ${tokens(s.jev.outputTokens)} output tokens, about ${usd(s.jev.costUsd)} (estimated).`] : []
  const rows = s.groups.map(g => `${g.key}: ${g.runs} runs${g.failures ? `, ${g.failures} failed` : ''}, median ${seconds(g.medianMs)} and ${tokens(g.medianTokens)} tokens`)
  return [head, ...asked, ...rows].join('\n')
}
