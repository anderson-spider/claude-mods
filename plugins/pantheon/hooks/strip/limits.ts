import { T, PACE_MARKS } from "./constants";
import { HOUR, DAY, duration, clockTime, dayTime } from "./formatting";

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
export const USED_ALERT = 90;

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
  const mark = elapsed === null ? "" : pace > limitData.paceStart ? `${PACE_MARKS.ahead}${points}` : pace < 0 ? `${PACE_MARKS.behind}${points}` : "";
  // The time left; the reset time and, when the use would reach 100% first, when it runs out
  // go to the pill's hover card.
  const when = left !== null ? duration(left) : "";
  return { kind: limit.kind, label: T.labels[limit.kind] ?? limit.kind, used, elapsed, tone, mark, value: T.percent(Math.round(used)), when, tip: tipOf(limit.kind, used, span, left, now) };
}

// "Resets at 18:00" (the 5-hour window) or "Resets Mon 14:00" (longer ones), and below it the
// moment the window would run out if the use kept the pace it has had so far, when that comes
// before the reset: a straight line through the share used over the time elapsed.
function tipOf(kind, used, span, left, now) {
  if (left === null) return "";
  const short = kind === "five_hour";
  const lines = [short ? T.resetsAt(clockTime(now + left)) : T.resetsOn(dayTime(now + left))];
  const gone = span ? span - left : 0;
  if (gone > 0 && used > 0 && used < 100) {
    const toFull = ((100 - used) / used) * gone;
    if (toFull < left) lines.push(short ? T.runsOutAt(clockTime(now + toFull)) : T.runsOutOn(dayTime(now + toFull)));
  }
  return lines.join("\n");
}

function bound(percent) {
  return Math.min(100, Math.max(0, percent));
}
