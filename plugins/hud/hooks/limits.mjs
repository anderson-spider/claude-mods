import { T, PACE_MARKS } from "./constants.mjs";
import { HOUR, DAY, duration, clockTime } from "./formatting.mjs";

// Length of each window; without one (spend cap), no elapsed-time marker.
const SPANS = { five_hour: 5 * HOUR, seven_day: 7 * DAY };
// Display order; an unknown window goes last.
const ORDER = ["five_hour", "seven_day", "spend_limit"];
// Pace = share used minus share of time elapsed, in points.
// Above the pace start (setting, 0 by default): using faster than time, amber with a ▲; beyond
// 15 points, or at 90% used: alert.
const PACE_ALERT = 15;
const PACE_START_MAX = 50;
// Latest known reading: { at (ms), list: SessionRateLimit[] }.
export const freshLimits = () => ({ at: 0, list: [] });
// How many points ahead of the clock a window may run before it is flagged.
export const limitData = { paceStart: 0, reading: freshLimits() };

// The pace start setting: a number (or numeric text) from 0 to 50; 0 when it is anything else.
export function paceStartOf(raw) {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(n, 0), PACE_START_MAX) : 0;
}
const USED_ALERT = 90;

export function sortLimits(list) {
  const rank = (kind) => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length);
  return [...list].sort((a, b) => rank(a.kind) - rank(b.kind));
}

// ---------- Limits: reading one window ----------

// What the line shows of a window: share used, time elapsed, tone, grey detail.
export function gaugeOf(limit, now) {
  const used = Math.max(0, limit.percentUsed);
  const resetMs = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
  const span = SPANS[limit.kind];
  const left = Number.isFinite(resetMs) ? Math.max(0, resetMs - now) : null;
  const elapsed = span && left !== null ? bound(((span - left) / span) * 100) : null;
  const pace = elapsed === null ? 0 : used - elapsed;
  const tone = used >= USED_ALERT || pace > PACE_ALERT ? "alert" : pace > limitData.paceStart ? "fast" : "calm";
  // Without a window length there is no clock to compare with: no mark.
  const points = Math.max(1, Math.round(Math.abs(pace)));
  const mark = elapsed === null ? "" : pace > limitData.paceStart ? `${PACE_MARKS.ahead} ${points}` : pace < 0 ? `${PACE_MARKS.behind} ${points}` : PACE_MARKS.even;
  // The time left; the 5-hour reset time goes to the clock's tooltip.
  const when = left !== null ? duration(left) : "";
  const resetAt = left !== null && limit.kind === "five_hour" ? clockTime(resetMs) : "";
  return { kind: limit.kind, label: T.labels[limit.kind] ?? limit.kind, used, elapsed, tone, mark, value: T.percent(Math.round(used)), when, resetAt };
}

function bound(percent) {
  return Math.min(100, Math.max(0, percent));
}
