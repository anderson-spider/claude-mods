import { checkKey } from './key'

/** One rate-limit window: how much is used (0-100) and when it resets (ISO 8601). */
export type Window = { percentUsed: number; resetsAt?: string }
/** What a provider reports; a window it does not report is absent. */
export type Reading = { fiveHour?: Window; sevenDay?: Window }
export type Provider = 'claude' | 'codex'
/** `ok` fresh reading; `unknown` none yet or none usable; `stale` too old; `down` the remote's management request failed; `off` not asked (no twin). */
export type CodexState = 'ok' | 'unknown' | 'stale' | 'down' | 'off'
/** The provider the readings favor and why; `reason` has no provider prefix. */
export type Decision = { provider: Provider; reason: string }
/** The value of the `quota` atom. */
export type Quota = {
  claude: Reading | null
  codex: Reading | null
  codexState: CodexState
  /** When the Codex usage was fetched (ms since epoch), or null before the first fetch. */
  fetchedAt: number | null
  /** When the Codex limits were observed (ms; the oldest window's), or null. */
  codexObservedAt: number | null
  /** When the last non-empty Claude reading was taken (ms), or null; the caller keeps the reading and stamps it. */
  claudeAt: number | null
  decision: Decision
}

/** The structure of a host `SessionRateLimit`, so this module needs no host import. */
export type RateLimitInput = { kind: string; percentUsed: number; resetsAt?: string }

export const DEADLINE_MS = 1500
/** A Codex usage result, failures included, is reused for this long: each read has the remote ask OpenAI. */
export const CACHE_MS = 5 * 60_000
export const STALE_MS = 15 * 60_000
/** A provider whose 5-hour window is used at least this much is not chosen. */
export const VETO = 90
/** Codex wins only with its 7-day used at least this many points below Claude's. */
export const MARGIN = 10
/** The remote's management API: its provider connections, and one connection's live usage. */
export const CONNECTIONS_PATH = '/api/providers'
export const usagePath = (connectionId: string): string => `/api/usage/${encodeURIComponent(connectionId)}`

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value))

/** Claude's windows from the host's rate limits; null when it reports neither (the caller keeps the last non-empty reading). */
export function claudeReading(rateLimits: readonly RateLimitInput[] | undefined | null): Reading | null {
  if (!Array.isArray(rateLimits)) return null
  const reading: Reading = {}
  for (const limit of rateLimits) {
    if (!isObject(limit) || typeof limit.percentUsed !== 'number' || !Number.isFinite(limit.percentUsed)) continue
    const key = limit.kind === 'five_hour' ? 'fiveHour' : limit.kind === 'seven_day' ? 'sevenDay' : undefined
    if (key === undefined || reading[key] !== undefined) continue
    reading[key] = {
      percentUsed: clampPercent(limit.percentUsed),
      ...(typeof limit.resetsAt === 'string' ? { resetsAt: limit.resetsAt } : {}),
    }
  }
  return reading.fiveHour || reading.sevenDay ? reading : null
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** A connection id as the remote writes it; anything else is not put in a request path. */
const CONNECTION_ID = /^[\w-]{1,64}$/

/** One usage quota as a Reading key and Window; unlimited, malformed or of another length is skipped. */
function usageWindow(raw: unknown, reached: boolean): ['fiveHour' | 'sevenDay', Window] | undefined {
  if (!isObject(raw) || raw.unlimited === true || !isNumber(raw.used) || !isNumber(raw.total) || raw.total <= 0 || raw.used < 0) return undefined
  const key = raw.windowSeconds === 5 * 3600 ? 'fiveHour' : raw.windowSeconds === 7 * 86400 ? 'sevenDay' : undefined
  if (key === undefined) return undefined
  const percentUsed = reached ? 100 : clampPercent((raw.used / raw.total) * 100)
  const resets = typeof raw.resetAt === 'string' ? Date.parse(raw.resetAt) : NaN
  return [key, { percentUsed, ...(Number.isNaN(resets) ? {} : { resetsAt: new Date(resets).toISOString() }) }]
}

/**
 * Codex's windows from the remote's usage answer for one connection: `quotas` holds windows `{used, total, resetAt,
 * windowSeconds}` under any name, so they are named by length and observed now. `limitReached` reads 100. A malformed
 * answer or no usable window is `unknown`. Never throws.
 */
export function codexUsage(text: unknown, now: number): { reading: Reading | null; state: 'ok' | 'unknown'; observedAt: number | null } {
  const unknown = { reading: null, state: 'unknown' as const, observedAt: null }
  try {
    const root: unknown = typeof text === 'string' ? JSON.parse(text) : text
    if (!isObject(root) || !isObject(root.quotas)) return unknown
    const reached = root.limitReached === true
    const reading: Reading = {}
    for (const quota of Object.values(root.quotas)) {
      const window = usageWindow(quota, reached)
      if (window && reading[window[0]] === undefined) reading[window[0]] = window[1]
    }
    if (!reading.fiveHour && !reading.sevenDay) return unknown
    return { reading, state: 'ok', observedAt: now }
  } catch {
    return unknown
  }
}

/** The id of the remote's one active Codex connection; none, or several, is undefined. */
export function activeCodexConnection(text: unknown): string | undefined {
  try {
    const root: unknown = typeof text === 'string' ? JSON.parse(text) : text
    if (!isObject(root) || !Array.isArray(root.connections)) return undefined
    const active = root.connections.filter(
      (connection): connection is Record<string, unknown> =>
        isObject(connection) && connection.provider === 'codex' && connection.isActive === true,
    )
    const id = active.length === 1 ? active[0]?.id : undefined
    return typeof id === 'string' && CONNECTION_ID.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

export type RemoteAccess = { ok: true; origin: string; headers: Record<string, string> } | { ok: false; reason: string }

/**
 * Where and how to ask the remote's management API: an `http:` or `https:` origin with no userinfo, path, query or
 * fragment, and the management token as a bearer. Reasons are fixed phrases: no URL or key text is in them.
 */
export function remoteAccess(remote: unknown, key: unknown): RemoteAccess {
  if (remote === undefined || remote === null || (typeof remote === 'string' && remote.trim() === '')) return { ok: false, reason: 'no codexRemote option' }
  const checked = checkKey(key)
  if (checked.key === undefined) return { ok: false, reason: checked.off === 'no-key' ? 'no codexManagementKey option' : 'the codexManagementKey option is not a valid key' }
  let url: URL
  try {
    url = new URL(String(remote).trim())
  } catch {
    return { ok: false, reason: 'the codexRemote option is not a URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'the codexRemote option is not an http or https URL' }
  if (url.username || url.password || (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    return { ok: false, reason: 'the codexRemote option must be an origin with no userinfo, path, query or fragment' }
  }
  return { ok: true, origin: url.origin, headers: { Authorization: `Bearer ${checked.key}`, Accept: 'application/json' } }
}

const pct = (window: Window | undefined): string => (window ? `${Math.round(window.percentUsed)}%` : 'n/a')

/** A window whose reset has passed counts as unknown. */
function live(window: Window | undefined, now: number): Window | undefined {
  if (!window) return undefined
  if (window.resetsAt !== undefined) {
    const resets = Date.parse(window.resetsAt)
    if (!Number.isNaN(resets) && resets <= now) return undefined
  }
  return window
}

/** The reason of a decision for a call that is not eligible (routing off or no twin): it names no provider. */
export const ROUTING_OFF_REASON = 'routing off or no Codex twin'

const NOT_KNOWN: Record<'unknown' | 'stale' | 'down' | 'off', string> = {
  unknown: 'Codex quota not known yet',
  stale: 'Codex quota is stale',
  down: 'Codex quota source is down',
  off: ROUTING_OFF_REASON,
}

/**
 * Which provider a routable call goes to, first match wins; anything uncertain is Claude: not eligible, Codex not fresh,
 * Claude without limits, Codex without a live 7-day window, the 5-hour veto (both vetoed: Claude; a Claude veto sends to
 * Codex only while Codex's 7-day is below VETO), then Codex only with its 7-day used at least MARGIN points below Claude's.
 * A window whose reset has passed (against `now`, ms) counts as unknown. Reasons carry no provider prefix.
 */
export function decide(claude: Reading | null, codex: Reading | null, codexState: CodexState, eligible: boolean, now: number): Decision {
  const toClaude = (reason: string): Decision => ({ provider: 'claude', reason })
  if (!eligible) return toClaude(NOT_KNOWN.off)
  if (codexState !== 'ok') return toClaude(NOT_KNOWN[codexState])
  if (!codex) return toClaude(NOT_KNOWN.unknown)
  const claude5 = live(claude?.fiveHour, now)
  const claude7 = live(claude?.sevenDay, now)
  if (!claude5 && !claude7) return toClaude('no Claude plan limits')
  const codex5 = live(codex.fiveHour, now)
  const codex7 = live(codex.sevenDay, now)
  if (!codex7) return toClaude('Codex has no 7d window')
  const claudeVetoed = claude5 !== undefined && claude5.percentUsed >= VETO
  const codexVetoed = codex5 !== undefined && codex5.percentUsed >= VETO
  if (claudeVetoed && codexVetoed) return toClaude(`both 5h windows at ${VETO}% or more`)
  if (codexVetoed) return toClaude(`Codex 5h ${pct(codex5)} used`)
  if (claudeVetoed) {
    if (codex7.percentUsed >= VETO) return toClaude(`Codex 7d ${pct(codex7)} used`)
    return { provider: 'codex', reason: `Claude 5h ${pct(claude5)} used` }
  }
  if (!claude7) return toClaude('Claude has no 7d window')
  if (claude7.percentUsed - codex7.percentUsed >= MARGIN) {
    return { provider: 'codex', reason: `7d ${pct(codex7)} used vs Claude 7d ${pct(claude7)}` }
  }
  return toClaude(`7d ${pct(claude7)} used vs Codex 7d ${pct(codex7)}`)
}

/** The atom's value before any reading: Codex is not asked (`off`) and the call stays on Claude. */
export const INITIAL_QUOTA: Quota = {
  claude: null,
  codex: null,
  codexState: 'off',
  fetchedAt: null,
  codexObservedAt: null,
  claudeAt: null,
  decision: { provider: 'claude', reason: NOT_KNOWN.off },
}

/**
 * The value with its `decision` recomputed from its own readings, so the atom never holds readings and a decision that
 * disagree. A Codex reading fetched more than STALE_MS ago is `stale` from here on, so the router never favors Codex
 * from it between spawns.
 */
export function settle(quota: Quota, eligible: boolean, now: number): Quota {
  const isOld = quota.codexState === 'ok' && quota.fetchedAt !== null && now - quota.fetchedAt > STALE_MS
  const codexState: CodexState = isOld ? 'stale' : quota.codexState
  return { ...quota, codexState, decision: decide(quota.claude, quota.codex, codexState, eligible, now) }
}
