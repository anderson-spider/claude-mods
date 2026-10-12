import { isLoopbackBase } from './agents'

/** One rate-limit window: how much is used (0-100) and when it resets (ISO 8601). */
export type Window = { percentUsed: number; resetsAt?: string }
/** What a provider reports; a window it does not report is absent. */
export type Reading = { fiveHour?: Window; sevenDay?: Window }
export type Provider = 'claude' | 'codex'
/** `ok` fresh reading; `unknown` none yet or none usable; `stale` too old; `down` the status request failed; `off` not asked (option off or no twin). */
export type CodexState = 'ok' | 'unknown' | 'stale' | 'down' | 'off'
/** The provider the readings favor and why; `reason` has no provider prefix. */
export type Decision = { provider: Provider; reason: string }
/** The value of the `quota` atom. */
export type Quota = {
  claude: Reading | null
  codex: Reading | null
  codexState: CodexState
  /** When the Codex status was fetched (ms since epoch), or null before the first fetch. */
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
/** A status result, failures included, is reused for this long. */
export const CACHE_MS = 60_000
export const STALE_MS = 15 * 60_000
/** An `observedAt` further ahead than this counts as stale (clock skew allowed). */
export const FUTURE_MS = 60_000
/** A provider whose 5-hour window is used at least this much is not chosen. */
export const VETO = 90
/** Codex wins only with its 7-day used at least this many points below Claude's. */
export const MARGIN = 10
/** The proxy calls OpenAI for fresh Codex limits only when the status request asks for it; a plain status never does. */
export const STATUS_PATH = '/__ccmproxy/status?refresh=limits'
export const TOKEN_HEADER = 'X-Ccmproxy-Token'

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

/** A time as ms since epoch: ISO text, or a number (Unix seconds below 1e12, else ms). */
function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value !== '') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? undefined : ms
  }
  return undefined
}

function windowOf(kind: unknown, minutes: unknown): 'fiveHour' | 'sevenDay' | undefined {
  if (kind === 'five_hour') return 'fiveHour'
  if (kind === 'seven_day') return 'sevenDay'
  const fromKind = typeof kind === 'string' ? /^window_(\d+)m$/.exec(kind) : null
  const m = fromKind ? Number(fromKind[1]) : typeof minutes === 'number' ? minutes : undefined
  return m === 300 ? 'fiveHour' : m === 10080 ? 'sevenDay' : undefined
}

/**
 * Codex's windows from the proxy status body (text or parsed). `unknown` when `codexLimits` is absent, empty, malformed or
 * holds no usable window; `stale` when any window's `observedAt` is missing, older than STALE_MS or in the future; `observedAt` is the oldest window's. Never throws.
 */
export function codexReading(
  statusJson: unknown,
  now: number,
): { reading: Reading | null; state: 'ok' | 'unknown' | 'stale'; observedAt: number | null } {
  try {
    let body = statusJson
    if (typeof body === 'string') body = JSON.parse(body)
    if (!isObject(body) || !Array.isArray(body.codexLimits)) return { reading: null, state: 'unknown', observedAt: null }
    const reading: Reading = {}
    let oldest: number | undefined
    let stale = false
    for (const row of body.codexLimits) {
      if (!isObject(row) || typeof row.percentUsed !== 'number' || !Number.isFinite(row.percentUsed)) continue
      const key = windowOf(row.kind, row.windowMinutes)
      if (key === undefined || reading[key] !== undefined) continue
      const resets = toMs(row.resetsAt)
      reading[key] = {
        percentUsed: clampPercent(row.percentUsed),
        ...(resets !== undefined ? { resetsAt: new Date(resets).toISOString() } : {}),
      }
      // Each window is judged on its own observedAt: missing, older than STALE_MS or in the future makes the reading stale.
      const seen = toMs(row.observedAt)
      if (seen === undefined || now - seen > STALE_MS || seen - now > FUTURE_MS) stale = true
      if (seen !== undefined && (oldest === undefined || seen < oldest)) oldest = seen
    }
    if (!reading.fiveHour && !reading.sevenDay) return { reading: null, state: 'unknown', observedAt: null }
    return { reading, state: stale ? 'stale' : 'ok', observedAt: oldest ?? null }
  } catch {
    // Also an out-of-range resetsAt (toISOString throws): the whole reading is unknown, which routes to Claude.
    return { reading: null, state: 'unknown', observedAt: null }
  }
}

/** The secret from ANTHROPIC_CUSTOM_HEADERS (newline-separated `Name: value` lines; the name is case-insensitive). */
function tokenOf(headers: unknown): string | undefined {
  if (typeof headers !== 'string') return undefined
  const line = headers.split(/\r?\n/).find(row => {
    const colon = row.indexOf(':')
    return colon > 0 && row.slice(0, colon).trim().toLowerCase() === TOKEN_HEADER.toLowerCase()
  })
  const token = line?.slice(line.indexOf(':') + 1).trim()
  return token ? token : undefined
}

export type ProxyAccess = { ok: true; url: string; headers: Record<string, string> } | { ok: false; reason: string }

/** Where and how to ask the proxy's status: a loopback `http:` base and the secret from the custom headers. */
export function proxyAccess(baseUrl: string | undefined, customHeaders: string | undefined): ProxyAccess {
  if (!baseUrl) return { ok: false, reason: 'no ANTHROPIC_BASE_URL' }
  if (!isLoopbackBase(baseUrl)) return { ok: false, reason: 'ANTHROPIC_BASE_URL is not a loopback http URL' }
  const token = tokenOf(customHeaders)
  if (!token) return { ok: false, reason: `no ${TOKEN_HEADER} in ANTHROPIC_CUSTOM_HEADERS` }
  const origin = new URL(baseUrl).origin
  return { ok: true, url: `${origin}${STATUS_PATH}`, headers: { [TOKEN_HEADER]: token } }
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
  down: 'Codex proxy is down',
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
