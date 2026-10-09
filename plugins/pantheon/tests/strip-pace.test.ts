import { test, expect } from "claude-code/testing";
import { HOT_FACTOR, PACE_POINTS, RECENT_MIN_MS, RECENT_MS, project, recentRate, recordPace } from "../hooks/strip/pace";
import type { PaceHistory } from "../hooks/strip/pace";

const H = 3_600_000;
const SPAN = 5 * H;

test("projection: runs out before the reset says when, from the average rate", () => {
  // 60% used in 2 of 5 hours: 30% an hour, the last 40% take 80 minutes, well before the reset.
  expect(project(60, SPAN, 3 * H)).toEqual({ kind: "full", inMs: 80 * 60_000, hot: false });
});

test("projection: under 100% at the reset says roughly how far it gets", () => {
  // 20% used in 2 hours: 10% an hour, 30 more points in the 3 hours left.
  expect(project(20, SPAN, 3 * H)).toEqual({ kind: "reset", pct: 50, hot: false });
});

test("projection: landing exactly on 100% at the reset is not a run-out and is never printed as 100", () => {
  // 40% in 2 hours: 20% an hour, exactly 100% at the reset.
  expect(project(40, SPAN, 3 * H)).toEqual({ kind: "reset", pct: 99, hot: false });
});

test("projection: a recent slope past 1.5x the average takes over and is hot", () => {
  const average = 60 / (2 * H);
  const fast = average * (HOT_FACTOR + 0.1);
  const out = project(60, SPAN, 3 * H, fast);
  expect(out).toEqual({ kind: "full", inMs: 40 / fast, hot: true });
  // Not enough faster: the average stands.
  expect(project(60, SPAN, 3 * H, average * (HOT_FACTOR - 0.1))).toEqual({ kind: "full", inMs: 80 * 60_000, hot: false });
  // A slow recent slope never lowers it.
  expect(project(60, SPAN, 3 * H, average / 10)).toEqual({ kind: "full", inMs: 80 * 60_000, hot: false });
});

test("projection: nothing at 0% used, at 100% or more, without a clock or before time has passed", () => {
  expect(project(0, SPAN, 3 * H)).toBeNull();
  expect(project(100, SPAN, 3 * H)).toBeNull();
  expect(project(120, SPAN, 3 * H)).toBeNull();
  expect(project(40, undefined, 3 * H)).toBeNull();
  expect(project(40, SPAN, null)).toBeNull();
  expect(project(40, SPAN, SPAN)).toBeNull();
});

test("history: a reading adds a point only when the use changed, keeps about ten and starts over on a reset", () => {
  const history: PaceHistory = {};
  recordPace(history, "five_hour", 1, 10, "r1");
  recordPace(history, "five_hour", 2, 10, "r1");
  expect(history.five_hour.points).toEqual([{ at: 1, used: 10 }]);
  for (let i = 1; i <= 15; i++) recordPace(history, "five_hour", 10 + i, 10 + i, "r1");
  expect(history.five_hour.points.length).toBe(PACE_POINTS);
  expect(history.five_hour.points[history.five_hour.points.length - 1]).toEqual({ at: 25, used: 25 });
  recordPace(history, "five_hour", 99, 3, "r1");
  expect(history.five_hour.points).toEqual([{ at: 99, used: 3 }]);
  recordPace(history, "seven_day", 5, 40, "r7");
  expect(Object.keys(history)).toEqual(["five_hour", "seven_day"]);
});

test("history: a new reset time starts the window over even when the use did not drop", () => {
  const history: PaceHistory = {};
  recordPace(history, "five_hour", 1, 10, "r1");
  recordPace(history, "five_hour", 2, 20, "r1");
  // The window rolled over and the new one is already at 30%: the old points do not belong to it.
  recordPace(history, "five_hour", 3, 30, "r2");
  expect(history.five_hour).toEqual({ resetsAt: "r2", points: [{ at: 3, used: 30 }] });
  // A reading with no reset time keeps the stored one.
  recordPace(history, "five_hour", 4, 35);
  expect(history.five_hour.resetsAt).toBe("r2");
  expect(history.five_hour.points.length).toBe(2);
});

test("recent rate: percent per millisecond from the oldest recent reading up to now", () => {
  const now = 100 * H;
  const points = [{ at: now - 40 * 60_000, used: 5 }, { at: now - 20 * 60_000, used: 20 }, { at: now - 10 * 60_000, used: 30 }];
  // The 40-minute-old point is outside the 30-minute window: the baseline is the one at -20 min.
  expect(Math.abs(recentRate(points, now, 50)! - 30 / (20 * 60_000))).toBeLessThan(1e-12);
});

test("recent rate: none without two readings, enough time, or growth since the baseline", () => {
  const now = 100 * H;
  expect(recentRate(undefined, now, 40)).toBeNull();
  expect(recentRate([], now, 40)).toBeNull();
  // Too short a span.
  expect(recentRate([{ at: now - RECENT_MIN_MS + 1000, used: 10 }], now, 40)).toBeNull();
  // Idle since a burst: the slope up to now has fallen to nothing.
  expect(recentRate([{ at: now - 20 * 60_000, used: 40 }], now, 40)).toBeNull();
  // Everything older than the window.
  expect(recentRate([{ at: now - RECENT_MS - 1, used: 10 }], now, 40)).toBeNull();
});
