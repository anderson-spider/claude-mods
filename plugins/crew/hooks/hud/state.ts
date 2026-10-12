// Reducers of the HUD's atoms: an event in, the new value out. Pure: time is an argument, nothing reads `$`. The hooks
// decide which atom an event feeds (a consult's spawn feeds `consults`, never `agents`; a step of an agent no atom knows
// feeds `loops`), using `isConsultType` (roles.ts) and `knownAgent`.
import { redactSecrets } from '../redact'
import { displayName, leadingStepId, providerOfType, stripTag, ADVISOR } from './roles'
import { oneLine, truncate } from './width'
import {
  NO_TOKENS,
  type Ask,
  type AgentCard,
  type Consult,
  type EndReason,
  type Favored,
  type LogKind,
  type LogLine,
  type Loop,
  type Provider,
  type Receipt,
  type Round,
  type RoundStatus,
  type Session,
  type StepUsage,
  type Verdict,
} from './types'

export const MAX_AGENTS = 24
export const MAX_CONSULTS = 24
export const MAX_LOG = 60
export const MAX_LOOPS = 24
export const MAX_TURNS = 50
export const MAX_ASKS = 8
export const MAX_ROUNDS = 20
/** A loop stepped within this long ago is active. */
export const LOOP_ACTIVE_MS = 15_000
/** A consult's first line is kept to this many cells. */
export const VERDICT_CELLS = 160

// ------------------------------------------------------------------ helpers

const n = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Context tokens of a request: input plus cache reads and writes. */
export function inputOf(usage: StepUsage | undefined): number {
  return n(usage?.input_tokens) + n(usage?.cache_read_input_tokens) + n(usage?.cache_creation_input_tokens)
}

/** The most a stored text keeps, in cells (a heredoc is not held whole in an atom). */
export const TEXT_CELLS = 300

/**
 * Text that enters an atom: secrets removed first (a cut token would no longer match its shape), then one line, then
 * capped. Paths stay: the HUD is local and the person needs them.
 */
export const safeText = (text: string, cells = TEXT_CELLS): string => truncate(oneLine(redactSecrets(text)), cells)

/** A bounded list that keeps the newest `max`. */
const keepLast = <T>(list: readonly T[], max: number): T[] => (list.length > max ? list.slice(list.length - max) : [...list])

/** The status a turn's end reason means. */
export function statusOf(reason: EndReason): Exclude<RoundStatus, 'running'> {
  return reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'
}

// ------------------------------------------------------------------ session

export function defaultSession(now = 0): Session {
  return {
    model: '',
    effort: '',
    mode: '',
    isWorking: false,
    contextPct: null,
    contextTokens: null,
    contextWindow: 0,
    costUsd: null,
    tokens: { ...NO_TOKENS },
    startedAt: now,
    compactions: 0,
    turn: null,
    turns: [],
    lastTurn: null,
    asks: [],
  }
}

/** A session (re)start: clears the counters and stamps the time. `model`/`mode` keep what is known when not given. */
export function sessionStarted(s: Session, e: { now: number; model?: string; mode?: string }): Session {
  return { ...defaultSession(e.now), model: e.model ?? s.model, mode: e.mode ?? s.mode }
}

export function modeChanged(s: Session, mode: string): Session {
  return s.mode === mode ? s : { ...s, mode }
}

/** A `session.measure`: the context fill and the cost. A missing figure keeps the old one. */
export function sessionMeasured(
  s: Session,
  e: { tokens?: number; window?: number; percent?: number; costUsd?: number },
): Session {
  const window = e.window !== undefined && e.window > 0 ? e.window : s.contextWindow
  const tokens = e.tokens ?? s.contextTokens
  const pct =
    e.percent !== undefined
      ? Math.min(100, Math.max(0, e.percent))
      : e.tokens !== undefined && window > 0
        ? Math.min(100, Math.max(0, (e.tokens / window) * 100))
        : s.contextPct
  return { ...s, contextWindow: window, contextTokens: tokens, contextPct: pct, costUsd: e.costUsd ?? s.costUsd }
}

/**
 * A model request finished or started a step. Tokens of every step, main loop and agents, add to the session and to the
 * turn in progress; a main-loop step also sets the model and effort and marks the loop working.
 */
export function sessionStepped(
  s: Session,
  e: { isMain: boolean; model?: string; effort?: string; usage?: StepUsage },
): Session {
  const input = inputOf(e.usage)
  const output = n(e.usage?.output_tokens)
  const next: Session = {
    ...s,
    tokens: {
      input: s.tokens.input + input,
      cacheRead: s.tokens.cacheRead + n(e.usage?.cache_read_input_tokens),
      output: s.tokens.output + output,
    },
    turn: s.turn ? { ...s.turn, input: s.turn.input + input, output: s.turn.output + output } : s.turn,
  }
  if (!e.isMain) return next
  return {
    ...next,
    isWorking: true,
    model: e.model && e.model !== '' ? e.model : next.model,
    effort: e.effort !== undefined ? e.effort : next.effort,
  }
}

export function turnStarted(s: Session, e: { now: number }): Session {
  return {
    ...s,
    isWorking: true,
    turn: { startedAt: e.now, costAtStart: s.costUsd, input: 0, output: 0, agents: 0 },
  }
}

/** A subagent was spawned: it counts toward the turn's receipt. */
export function turnSpawned(s: Session): Session {
  return s.turn ? { ...s, turn: { ...s.turn, agents: s.turn.agents + 1 } } : s
}

/** The main loop's turn ended: the receipt, the lead's lane and the idle state. */
export function turnEnded(s: Session, e: { now: number; reason: EndReason; durationMs?: number }): Session {
  const started = s.turn?.startedAt ?? (e.durationMs !== undefined ? e.now - e.durationMs : e.now)
  const durationMs = Math.max(0, e.durationMs ?? e.now - started)
  const spent =
    s.costUsd !== null && s.turn?.costAtStart !== null && s.turn?.costAtStart !== undefined
      ? Math.max(0, s.costUsd - s.turn.costAtStart)
      : null
  const receipt: Receipt = {
    outcome: statusOf(e.reason),
    reason: e.reason,
    durationMs,
    costUsd: spent,
    input: s.turn?.input ?? 0,
    output: s.turn?.output ?? 0,
    agents: s.turn?.agents ?? 0,
  }
  return {
    ...s,
    isWorking: false,
    turn: null,
    lastTurn: receipt,
    turns: keepLast([...s.turns, { startedAt: e.now - durationMs, endedAt: e.now }], MAX_TURNS),
  }
}

export function sessionCompacted(s: Session): Session {
  return { ...s, compactions: s.compactions + 1 }
}

export function askOpened(s: Session, ask: Ask): Session {
  const safe = { ...ask, who: safeText(ask.who, 60), tool: safeText(ask.tool, 120) }
  return { ...s, asks: keepLast([...s.asks.filter(a => a.id !== ask.id), safe], MAX_ASKS) }
}

export function askClosed(s: Session, id: string): Session {
  return s.asks.some(a => a.id === id) ? { ...s, asks: s.asks.filter(a => a.id !== id) } : s
}

/** The share of input read from the cache, 0-100, or null before any input. */
export function cachedShare(s: Session): number | null {
  return s.tokens.input > 0 ? Math.round((s.tokens.cacheRead / s.tokens.input) * 100) : null
}

// ------------------------------------------------------------------ agents

export const isRunning = (card: AgentCard): boolean => lastRound(card)?.status === 'running'

export const lastRound = (card: AgentCard): Round | undefined => card.rounds[card.rounds.length - 1]

/** The status an agent row shows: its latest round's. */
export const statusOfCard = (card: AgentCard): RoundStatus => lastRound(card)?.status ?? 'done'

/** Drops the oldest ended card first, then the oldest of all, until the list fits. */
function bounded(list: AgentCard[]): AgentCard[] {
  const out = [...list]
  while (out.length > MAX_AGENTS) {
    const at = out.findIndex(card => !isRunning(card))
    out.splice(at >= 0 ? at : 0, 1)
  }
  return out
}

export type SpawnEvent = {
  id: string
  /** The final type, `-codex` included. */
  type: string
  description: string
  /** The planned model (alias or id); '' when unknown. */
  model?: string
  effort?: string
  /** From the crew's `shared` info; otherwise a `-codex` type means Codex. */
  provider?: Provider
  now: number
}

/** A subagent was spawned: a card with one running round. A spawn of a known id restarts its card. */
export function agentSpawned(list: readonly AgentCard[], e: SpawnEvent): AgentCard[] {
  const description = safeText(stripTag(e.description))
  const card: AgentCard = {
    id: e.id,
    type: e.type,
    provider: e.provider ?? providerOfType(e.type),
    description,
    stepId: leadingStepId(description),
    model: e.model ?? '',
    effort: e.effort ?? '',
    spawnedAt: e.now,
    rounds: [{ startedAt: e.now, status: 'running' }],
    steps: 0,
    ctx: 0,
    output: 0,
    lastStop: null,
    lastTool: '',
    denied: '',
  }
  return bounded([...list.filter(c => c.id !== e.id), card])
}

const update = (list: readonly AgentCard[], id: string, fn: (card: AgentCard) => AgentCard): AgentCard[] =>
  list.some(c => c.id === id) ? list.map(c => (c.id === id ? fn(c) : c)) : [...list]

export type StepEvent = {
  id: string
  model?: string
  /** A number or a name; '' or absent when the host sends none. */
  effort?: string | number
  usage?: StepUsage
  stopReason?: string | null
  now: number
}

/**
 * An agent's model step. A step of an agent whose last round ended starts a new round (a resumed subagent). The model
 * the API reported replaces the planned one; context is the request's input tokens.
 */
export function agentStepped(list: readonly AgentCard[], e: StepEvent): AgentCard[] {
  return update(list, e.id, card => {
    const last = lastRound(card)
    const rounds =
      last && last.status === 'running'
        ? card.rounds
        : keepLast([...card.rounds, { startedAt: e.now, status: 'running' as const }], MAX_ROUNDS)
    const ctx = inputOf(e.usage)
    return {
      ...card,
      rounds,
      model: e.model && e.model !== '' ? e.model : card.model,
      effort: e.effort !== undefined && e.effort !== '' ? String(e.effort) : card.effort,
      steps: card.steps + (e.usage ? 1 : 0),
      ctx: ctx > 0 ? ctx : card.ctx,
      output: card.output + n(e.usage?.output_tokens),
      lastStop: e.stopReason !== undefined ? e.stopReason : card.lastStop,
    }
  })
}

/** An agent called a tool: `Edit internal/config/x.go`. Clears a previous denial. */
export function agentTool(list: readonly AgentCard[], id: string, text: string): AgentCard[] {
  return update(list, id, card => ({ ...card, lastTool: safeText(text), denied: '' }))
}

/** A call of the agent's was refused: `Bash git push`. */
export function agentDenied(list: readonly AgentCard[], id: string, text: string): AgentCard[] {
  return update(list, id, card => ({ ...card, denied: safeText(text) }))
}

/** The agent's turn ended; `reason` is the host's. A failure names `max_tokens` when the last step ran out of tokens. */
export function agentCompleted(list: readonly AgentCard[], e: { id: string; reason: EndReason; now: number }): AgentCard[] {
  return update(list, e.id, card => {
    const last = lastRound(card)
    if (!last || last.status !== 'running') return card
    const status = statusOf(e.reason)
    const failure =
      status === 'failed' ? (card.lastStop === 'max_tokens' ? 'max_tokens' : e.reason === 'refusal' ? 'refusal' : 'error') : undefined
    const ended: Round = { ...last, status, endedAt: e.now, ...(failure ? { failure } : {}) }
    return { ...card, rounds: [...card.rounds.slice(0, -1), ended] }
  })
}

/** Marks every running round stopped (the session ended or the person cleared it). */
export function agentsStopped(list: readonly AgentCard[], now: number): AgentCard[] {
  return list.map(card => {
    const last = lastRound(card)
    if (!last || last.status !== 'running') return card
    return { ...card, rounds: [...card.rounds.slice(0, -1), { ...last, status: 'stopped' as const, endedAt: now }] }
  })
}

/** Live agents, oldest first. */
export const runningAgents = (list: readonly AgentCard[]): AgentCard[] =>
  list.filter(isRunning).sort((a, b) => a.spawnedAt - b.spawnedAt)

/** Whether any atom of the HUD holds this id (agents and consults); anything else that steps is a loop. */
export const knownAgent = (agents: readonly AgentCard[], consults: readonly Consult[], id: string): boolean =>
  agents.some(c => c.id === id) || consults.some(c => c.id === id)

/** When the last agent round ended, or null if none ended (nothing ran, or something runs). */
export function lastEndedAt(list: readonly AgentCard[]): number | null {
  let at: number | null = null
  for (const card of list) for (const round of card.rounds) if (round.endedAt !== undefined && (at === null || round.endedAt > at)) at = round.endedAt
  return at
}

/** An agent's context over the session's window, 0-100, or null when either is unknown. */
export function agentContextPct(card: AgentCard, window: number): number | null {
  return card.ctx > 0 && window > 0 ? Math.min(100, Math.round((card.ctx / window) * 100)) : null
}

// ------------------------------------------------------------------ consults

/** Strips Markdown marks from a line: emphasis, heading hashes, quote and bullet markers, backticks. */
function plainLine(raw: string): string {
  return raw
    .replace(/^[\s>#*\-+•]+/, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const VERDICT_WORD = /^(approved?|fixes|reject(?:ed|s)?)\b[\s:—–-]*/i

/**
 * The first non-empty line of an answer, Markdown marks stripped, and the verdict word it opens with (`Approve`,
 * `Fixes`, `Reject`; case-insensitive) with the rest as the reason. A line without the word has no verdict.
 */
export function parseVerdict(answer: string): { line: string; verdict: Verdict | null; reason: string } {
  // A hand-back opens with a header ("The report follows:"); the review's warning or an agent-message tag can lead the text.
  const marker = /the report follows:/i.exec(answer)
  const body = marker ? answer.slice(marker.index + marker[0].length) : answer
  const first =
    body
      .split(/\r?\n/)
      .filter(raw => !/^\s*[<[]/.test(raw))
      .map(raw => oneLine(redactSecrets(plainLine(raw))))
      .find(line => line !== '') ?? ''
  const line = truncate(first, VERDICT_CELLS)
  const match = VERDICT_WORD.exec(first)
  if (!match) return { line, verdict: null, reason: line }
  const word = (match[1] as string).toLowerCase()
  const verdict: Verdict = word.startsWith('approve') ? 'Approve' : word.startsWith('fix') ? 'Fixes' : 'Reject'
  return { line, verdict, reason: truncate(first.slice(match[0].length).trim(), VERDICT_CELLS) }
}

export type ConsultStart = { id: string; type: string; description: string; now: number }

/** A consult began (an architect spawn, or the advisor tool). */
export function consultStarted(list: readonly Consult[], e: ConsultStart): Consult[] {
  const description = safeText(stripTag(e.description))
  const consult: Consult = {
    id: e.id,
    who: e.type === ADVISOR ? ADVISOR : displayName(e.type),
    at: e.now,
    endAt: null,
    description,
    stepId: leadingStepId(description),
    line: '',
    verdict: null,
    reason: '',
  }
  return keepLast([...list.filter(c => c.id !== e.id), consult], MAX_CONSULTS)
}

/** A consult ended with its answer (empty when it was stopped or failed). */
export function consultEnded(list: readonly Consult[], e: { id: string; now: number; answer?: string }): Consult[] {
  return list.map(c => {
    if (c.id !== e.id || c.endAt !== null) return c
    return { ...c, endAt: e.now, ...parseVerdict(e.answer ?? '') }
  })
}

export const consulting = (list: readonly Consult[]): Consult[] => list.filter(c => c.endAt === null)

// ------------------------------------------------------------------ log

/** Appends a line; the ring keeps the newest 60. */
export function logged(list: readonly LogLine[], line: LogLine): LogLine[] {
  return keepLast([...list, line], MAX_LOG)
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Your prompt as a log line: its first non-empty line, secrets removed. */
export function promptLine(text: string, now: number): LogLine {
  const first = text.split(/\r?\n/).map(squash).find(line => line !== '') ?? ''
  return { at: now, who: 'you', kind: 'prompt', text: safeText(first) }
}

export function spawnLine(card: AgentCard, now: number): LogLine {
  return { at: now, who: displayName(card.type), kind: 'spawn', text: `spawned · ${card.description}`, type: card.type }
}

/** The line for a round that ended: done, failed (with the reason) or stopped. */
export function endLine(card: AgentCard, now: number): LogLine | null {
  const round = lastRound(card)
  if (!round || round.status === 'running') return null
  const who = displayName(card.type)
  const kind: LogKind = round.status === 'done' ? 'done' : round.status === 'failed' ? 'failed' : 'stopped'
  const text =
    round.status === 'done'
      ? `done · ${card.description}`
      : round.status === 'failed'
        ? `✗ failed · ${round.failure ?? 'error'}`
        : `stopped · ${card.description}`
  return { at: now, who, kind, text, type: card.type }
}

export function denyLine(who: string, text: string, now: number, type?: string): LogLine {
  return { at: now, who, kind: 'deny', text: `✗ denied ${safeText(text)}`, ...(type ? { type } : {}) }
}

export function consultLine(c: Consult): LogLine {
  return {
    at: c.at,
    who: c.who,
    kind: 'consult',
    text: `consult · ${c.description}`,
    type: c.who === ADVISOR ? ADVISOR : 'crew:architect',
  }
}

export function verdictLine(c: Consult): LogLine {
  return {
    at: c.endAt ?? c.at,
    who: c.who,
    kind: 'verdict',
    text: c.line === '' ? 'ended without an answer' : c.line,
    type: c.who === ADVISOR ? ADVISOR : 'crew:architect',
  }
}

export const compactLine = (now: number): LogLine => ({ at: now, who: 'lead', kind: 'compact', text: 'context compacted' })

// ------------------------------------------------------------------ loops

/** A step of an agent no card holds: a workflow agent or a fork. */
export function loopStepped(list: readonly Loop[], id: string, now: number): Loop[] {
  const found = list.find(l => l.id === id)
  const next: Loop = found
    ? { ...found, lastAt: now, steps: found.steps + 1, isDone: false }
    : { id, firstAt: now, lastAt: now, steps: 1, isDone: false }
  return keepLast([...list.filter(l => l.id !== id), next], MAX_LOOPS)
}

export function loopEnded(list: readonly Loop[], id: string): Loop[] {
  return list.map(l => (l.id === id ? { ...l, isDone: true } : l))
}

export const isLoopActive = (loop: Loop, now: number): boolean => !loop.isDone && now - loop.lastAt < LOOP_ACTIVE_MS

/** The count and the active share for `⋯ 2 loops · 1 active (workflow agents, forks)`; null when there are none. */
export function loopSummary(list: readonly Loop[], now: number): { total: number; active: number } | null {
  if (list.length === 0) return null
  return { total: list.length, active: list.filter(l => isLoopActive(l, now)).length }
}

// ------------------------------------------------------------------ favored provider

/** Tracks which provider the router last favored; a change is stamped, the first reading is not a change. */
export function trackFavored(prev: Favored | null, provider: Provider, now: number): Favored {
  if (prev === null) return { provider, since: now, isChange: false }
  return prev.provider === provider ? prev : { provider, since: now, isChange: true }
}

export const FAVORED_RECENT_MS = 10 * 60_000

/** Whether the favored provider changed in the last 10 minutes. */
export const favoredChangedRecently = (f: Favored | null, now: number): boolean =>
  f !== null && f.isChange && now - f.since < FAVORED_RECENT_MS
