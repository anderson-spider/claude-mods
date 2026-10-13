// Pure figures for the card: a rate-limit window's pace, the cache share, spans of time and money. No host access.

const HOUR = 3_600_000
/** How long each window the host names lasts; a window not listed has no pace. */
export const WINDOW_MS: Readonly<Record<string, number>> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }

/** A window's reading against the clock: what is used, how much of it has passed, and where the pace leads. */
export type Pace = {
  /** Percent used, 0 to 100 (past 100 when exceeded). */
  used: number
  /** The share of the window already passed, 0 to 1; the bar's tick. */
  elapsed: number
  /** Milliseconds until the window resets. */
  left: number
  /** Whole points used above an even pace; 0 when at or below it. */
  ahead: number
  /** The percent the current pace reaches at the reset. */
  atReset: number
  /** Milliseconds until the pace reaches 100, when it does before the reset. */
  fullIn?: number
}

/** A pace needs this share of the window passed before projecting: earlier, a few calls would read as a runaway pace. */
const MIN_ELAPSED = 0.02

/** The pace of one window at `now`, or undefined when its length, reset time or reading is unknown. */
export function paceOf(limit: { kind: string; percentUsed: number; resetsAt?: string }, now: number): Pace | undefined {
  const length = WINDOW_MS[limit.kind]
  const reset = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  if (length === undefined || !Number.isFinite(reset) || !Number.isFinite(now) || !Number.isFinite(limit.percentUsed)) return undefined
  const used = Math.max(0, limit.percentUsed)
  const left = Math.max(0, reset - now)
  const elapsed = Math.min(1, Math.max(0, 1 - left / length))
  const ahead = Math.max(0, Math.round(used - elapsed * 100))
  if (elapsed < MIN_ELAPSED) return { used, elapsed, left, ahead, atReset: used }
  const atReset = Math.round(used / elapsed)
  const rate = used / (elapsed * length)
  const fullIn = atReset > 100 && used < 100 && rate > 0 ? Math.round((100 - used) / rate) : undefined
  return fullIn === undefined ? { used, elapsed, left, ahead, atReset } : { used, elapsed, left, ahead, atReset, fullIn }
}

/** The share of an input read from the prompt cache, 0 to 100, or undefined when the usage carries no input. */
export function cacheShare(usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): number | undefined {
  const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
  if (!parts.every(n => Number.isFinite(n) && n >= 0)) return undefined
  const total = parts[0]! + parts[1]! + parts[2]!
  return total > 0 ? Math.round((parts[1]! / total) * 100) : undefined
}

/** A span as the card writes it: `5s`, `38m`, `4h 56m`, `3d 12h`. */
export function span(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Dollars with cents: `$4.59`; a non-finite or negative amount is `?`. */
export function money(usd: number): string {
  return Number.isFinite(usd) && usd >= 0 ? `$${usd.toFixed(2)}` : '?'
}
