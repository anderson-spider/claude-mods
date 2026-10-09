import { test, expect } from "claude-code/testing";
import { EDIT_TOOLS, freshTurn, noteCost, noteSpawn, noteTool, noteTurnEnd, noteTurnStart, turnData } from "../hooks/strip/receipt";
import { noteMeasure, noteStep, noteStripSpawn, noteStripTool, noteStripTurnStart, noteTurnComplete, startStrip } from "../hooks/strip/state";
import type { StripHost } from "../hooks/strip/state";
import { contextData } from "../hooks/strip/context";
import { infoData } from "../hooks/strip/info";
import { gaugeOf, limitData } from "../hooks/strip/limits";
import { project, recentRate } from "../hooks/strip/pace";
import { NOW, reset, windowOf } from "./strip-fixtures";

function host(over: Partial<StripHost> = {}, store = new Map<string, unknown>()): StripHost {
  return {
    now: async () => NOW, sessionId: async () => "s1", cwd: async () => { throw new Error("none"); }, model: async () => "",
    run: async () => ({ exitCode: 1, stdout: "" }),
    usage: async () => ({ context: { tokens: 100_000, window: 1_000_000, percent: 10 }, rateLimits: [windowOf("five_hour", 20, 0.3)], cost: { usd: 10 } }),
    storeKeys: async () => [...store.keys()], storeGet: async (k) => store.get(k), storeSet: async (k, v) => { store.set(k, v); }, storeDelete: async (k) => { store.delete(k); },
    ...over,
  };
}
const ENV = { off: "", force5m: "", ttl: "", enable1h: "" };

test("receipt: counters reset at a turn start and the finished turn keeps agents, edits, errors, cost and context", () => {
  reset();
  contextData.readings = [{ tokens: 100_000, window: 1_000_000, percent: 10 }];
  noteCost(10);
  noteTurnStart();
  noteSpawn(); noteSpawn();
  for (const tool of EDIT_TOOLS) noteTool(tool, {});
  noteTool("Read", {});
  noteTool("Bash", { isError: true });
  contextData.readings.push({ tokens: 106_300, window: 1_000_000, percent: 10 });
  noteCost(10.18);
  noteTurnEnd({ durationMs: 157_000, reason: "answer" });
  expect(turnData.last).toEqual({ ms: 157_000, agents: 2, edits: 3, errors: 1, usd: expect.any(Number), ctx: 6300 });
  expect(Math.round(turnData.last!.usd! * 100)).toBe(18);
  // The next turn starts from zero; the last receipt stays until it ends.
  noteTurnStart();
  expect([turnData.agents, turnData.edits, turnData.errors]).toEqual([0, 0, 0]);
  expect(turnData.last!.agents).toBe(2);
});

test("receipt: a denied call counts for nothing, a failed edit is an error not an edit, an error turn end adds one", () => {
  reset();
  noteTurnStart();
  noteTool("Edit", { isDenied: true });
  noteTool("Edit", { isError: true });
  noteTool("Write", {});
  noteTurnEnd({ durationMs: 1000, reason: "error" });
  expect(turnData.last).toMatchObject({ edits: 1, errors: 2 });
});

test("receipt: without a ledger the cost is unknown and never negative", () => {
  reset();
  noteTurnStart();
  noteTurnEnd({ durationMs: 1000 });
  expect(turnData.last!.usd).toBeNull();
  noteCost(5);
  noteTurnStart();
  noteCost(4);
  noteTurnEnd({ durationMs: 1000 });
  expect(turnData.last!.usd).toBe(0);
  noteCost(undefined);
  noteCost(NaN);
  expect(turnData.usd).toBe(4);
  expect(freshTurn().last).toBeNull();
});

test("state: the receipt counters come from the entry's handlers; results are read, never changed", () => {
  reset();
  noteStripTurnStart();
  noteStripSpawn();
  const denied = Object.freeze({ deny: "no" });
  const failed = Object.freeze({ isError: true, result: "boom" });
  const fine = Object.freeze({ result: "ok" });
  noteStripTool("Edit", denied);
  noteStripTool("Edit", failed);
  noteStripTool("NotebookEdit", fine);
  noteStripTool("Bash", undefined);
  expect([turnData.agents, turnData.edits, turnData.errors]).toEqual([1, 1, 1]);
});

test("state: the session starts with the ledger's cost and the windows' first readings; a turn end reads the new cost", async () => {
  reset();
  const store = new Map<string, unknown>();
  let usd = 10;
  const h = host({ usage: async () => ({ context: { tokens: 100_000, window: 1_000_000, percent: 10 }, rateLimits: [windowOf("five_hour", 20, 0.3)], cost: { usd } }) }, store);
  await startStrip(h, ENV);
  expect(turnData.usd).toBe(10);
  expect(limitData.history.five_hour.points).toEqual([{ at: NOW, used: 20 }]);
  noteStripTurnStart();
  usd = 10.5;
  contextData.readings.push({ tokens: 120_000, window: 1_000_000, percent: 12 });
  await noteTurnComplete(h, { durationMs: 90_000, reason: "answer" });
  expect(turnData.last!.ms).toBe(90_000);
  expect(Math.round(turnData.last!.usd! * 100)).toBe(50);
  expect((store.get("turns:s1") as any).paces.five_hour.points).toEqual([{ at: NOW, used: 20 }]);
});

test("state: a measurement updates the cost and records a window's new use for the burn rate", async () => {
  reset();
  const store = new Map<string, unknown>();
  const h = host({}, store);
  await startStrip(h, ENV);
  await noteMeasure(h, { changed: ["cost"], rateLimits: [], cost: { usd: 12 } });
  expect(turnData.usd).toBe(12);
  await noteMeasure({ ...h, now: async () => NOW + 60_000 }, { changed: ["rateLimits"], rateLimits: [windowOf("five_hour", 25, 0.3)] });
  expect(limitData.history.five_hour.points).toEqual([{ at: NOW, used: 20 }, { at: NOW + 60_000, used: 25 }]);
});

test("state: ⚡fast follows the last request's speed", () => {
  reset();
  expect(noteStep({ model: "claude-opus-5-5", effort: "medium" }, { usage: { speed: "fast", input_tokens: 1 } }, NOW)).toBe(true);
  expect(infoData.current.speed).toBe("fast");
  noteStep({ model: "claude-opus-5-5" }, { usage: { speed: "standard", input_tokens: 1 } }, NOW);
  expect(infoData.current.speed).toBe("");
  expect(noteStep({ model: "m" }, undefined, NOW)).toBe(false);
});

test("state: each main-loop request moves the context reading, so the strip does not wait for the turn to end", () => {
  reset();
  contextData.readings = [{ tokens: 0, window: 1_000_000, percent: 0 }];
  noteStep({ model: "claude-opus-5-5" }, { usage: { input_tokens: 2_000, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 8_000 } }, NOW);
  expect(contextData.readings).toEqual([{ tokens: 90_000, window: 1_000_000, percent: 9 }]);
  // No window known yet: nothing to measure against, no reading.
  contextData.readings = [];
  noteStep({ model: "claude-opus-5-5" }, { usage: { input_tokens: 5 } }, NOW);
  expect(contextData.readings).toEqual([]);
});

test("state: a reading adopted from another session keeps its own age, so a later measurement is not mistaken for a burst", async () => {
  reset();
  const store = new Map<string, unknown>();
  const old = windowOf("five_hour", 40, 0.4);
  // Another session measured 3 hours ago.
  store.set("limits", { at: NOW - 3 * 3_600_000, list: [old] });
  const h = host({ usage: async () => ({ context: { tokens: 1000, window: 1_000_000, percent: 1 }, rateLimits: [], cost: { usd: 1 } }) }, store);
  await startStrip(h, ENV);
  expect(limitData.history.five_hour.points).toEqual([{ at: NOW - 3 * 3_600_000, used: 40 }]);
  // Five minutes later the window reads 46%: 6 points in 5 minutes against an hourly average of 20.
  const later = NOW + 5 * 60_000;
  await noteMeasure({ ...h, now: async () => later }, { changed: ["rateLimits"], rateLimits: [{ ...old, percentUsed: 46 }] });
  const g = gaugeOf({ ...old, percentUsed: 46 }, later);
  const rate = recentRate(limitData.history.five_hour.points, later, 46);
  // The 3-hour-old point is outside the recent window: no slope, so no burning.
  expect(rate).toBeNull();
  const p = project(g.used, g.span, g.left, rate);
  expect(p?.hot).toBe(false);
});
