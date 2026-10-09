import { T } from "./constants";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// 42m, 3h 2m, 3h, 5d 6h, 5d: the largest two units, a zero second unit left out.
export function duration(ms) {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days}${T.day} ${hours}h` : `${days}${T.day}`;
  return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

// 24-hour time in the machine's time zone; UTC when the runtime has no time zone data.
export function clockTime(ms) {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  } catch {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  }
}

// "Mon 14:00": a moment within the week, in the machine's time zone.
export function dayTime(ms) {
  try {
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms).replace(",", "");
  } catch {
    return clockTime(ms);
  }
}

// 1M, 1.2M, 107k, 98.3k, 950: one decimal only when it matters.
export function short(n) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 100_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(n);
}
