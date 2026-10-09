// The pace projection ("ritmo") of a quota window. New for pantheon's strip; no hud code in it.
//
// Average: rate = used% / time elapsed in the window, the straight line the clock mark implies.
//   - runs out first: toFull = (100 - used) / rate; when toFull < time left, "100% in <toFull>";
//   - otherwise "~N% at reset" with N = min(99, used + rate * left).
// Recent slope: when the last readings (about 10 of them, at most 30 minutes old) show the use
// climbing at more than 1.5x the average, that faster rate is projected instead and the
// projection is "hot" (drawn as burning). The slope runs up to `now`, so an idle spell after a
// burst brings it back down on its own.
// Nothing is projected at 0% used, at 100% or more, or before any time has elapsed.

export type PacePoint = { at: number; used: number }
/** What is kept per window: the reset time it belongs to and its recent readings. */
export type PaceHistory = Record<string, { resetsAt?: string; points: PacePoint[] }>
export type Projection = { kind: 'full'; inMs: number; hot: boolean } | { kind: 'reset'; pct: number; hot: boolean }

/** Readings kept per window. */
export const PACE_POINTS = 10
/** How far back the recent slope looks. */
export const RECENT_MS = 30 * 60_000
/** The slope needs at least this much time behind it. */
export const RECENT_MIN_MS = 5 * 60_000
/** The recent slope counts as burning past this multiple of the average. */
export const HOT_FACTOR = 1.5

/**
 * Notes a reading of a window, taken at `at` (the reading's own time, never the moment it was
 * adopted). A new reset time or a drop in use means the window started over: the history too.
 */
export function recordPace(history: PaceHistory, kind: string, at: number, used: number, resetsAt?: string): void {
  const entry = history[kind] ?? { resetsAt, points: [] }
  const last = entry.points[entry.points.length - 1]
  if ((resetsAt !== undefined && entry.resetsAt !== undefined && entry.resetsAt !== resetsAt) || (last && used < last.used)) entry.points = []
  entry.resetsAt = resetsAt ?? entry.resetsAt
  // The same use as the last reading adds nothing: the older point stays as the baseline.
  if (entry.points.length === 0 || entry.points[entry.points.length - 1].used !== used) entry.points.push({ at, used })
  entry.points = entry.points.slice(-PACE_POINTS)
  history[kind] = entry
}

/** Percent per millisecond over the recent readings up to now, or null without enough of them. */
export function recentRate(points: PacePoint[] | undefined, now: number, used: number): number | null {
  const recent = (points ?? []).filter(p => p.at <= now && now - p.at <= RECENT_MS)
  if (recent.length === 0) return null
  const first = recent[0]
  const time = now - first.at
  if (time < RECENT_MIN_MS || used <= first.used) return null
  return (used - first.used) / time
}

export function project(used: number, spanMs: number | undefined, leftMs: number | null, recent: number | null = null): Projection | null {
  if (!spanMs || leftMs === null) return null
  const gone = spanMs - leftMs
  if (!(used > 0) || used >= 100 || !(gone > 0)) return null
  let rate = used / gone
  let hot = false
  if (recent !== null && recent > rate * HOT_FACTOR) {
    rate = recent
    hot = true
  }
  const toFull = (100 - used) / rate
  if (toFull < leftMs) return { kind: 'full', inMs: toFull, hot }
  return { kind: 'reset', pct: Math.min(99, Math.round(used + rate * leftMs)), hot }
}
