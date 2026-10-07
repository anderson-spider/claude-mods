import { test, expect } from "claude-code/testing";
import { restoreTurns, saveTurns, shareLimits, adoptShared, TURNS_PREFIX } from "../hooks/history.mjs";
import { startSuggestions, togglePick, writePicks } from "../hooks/suggestion-flow.mjs";
import { refreshInfo } from "../hooks/info-refresh.mjs";
import { renderHud } from "../hooks/render.mjs";
import { contextData, freshContext, HISTORY } from "../hooks/context.mjs";
import { cacheData, freshCache } from "../hooks/cache.mjs";
import { limitData, freshLimits } from "../hooks/limits.mjs";
import { suggestionData, freshSuggestions } from "../hooks/suggestions.mjs";
import { infoData, freshInfo } from "../hooks/info.mjs";

const NOW = 1_800_000_000_000;
const KEEP = 8 * 24 * 3_600_000;
const ITEMS = [{ label: "Test", prompt: "Run the tests" }, { label: "Review", prompt: "Review the diff" }];
const show = (next: any) => { suggestionData.current = next; };
const elements = Object.fromEntries(["Box", "Text", "Button"].map((type) => [type, (props: any) => ({ type, props, children: props.children })]));

function reset() {
  Object.assign(contextData, freshContext());
  Object.assign(cacheData, freshCache(), { env: {} });
  limitData.reading = freshLimits();
  Object.assign(infoData, freshInfo());
  Object.assign(suggestionData, { current: freshSuggestions(), minAnswerChars: 80, suggestSkills: true });
}

test("history: restores valid readings and only expires other sessions at eight days", async () => {
  reset();
  const key = TURNS_PREFIX + "current";
  const stored: any = {
    [key]: { at: 0, readings: [null, { window: 0 }, ...Array.from({ length: HISTORY + 2 }, (_, tokens) => ({ tokens, window: 100 }))], cache: { at: 10 }, compacted: true, seenTtl: "1h" },
    [TURNS_PREFIX + "old"]: { at: NOW - KEEP },
    [TURNS_PREFIX + "recent"]: { at: NOW - KEEP + 1 },
    limits: { at: 0 },
  };
  const removed: string[] = [];
  await restoreTurns({ now: async () => NOW, keys: async () => Object.keys(stored), get: async (k: string) => stored[k], remove: async (k: string) => { removed.push(k); } }, () => key);
  expect(contextData.readings.length).toBe(HISTORY);
  expect(contextData.readings[0].tokens).toBe(2);
  expect(cacheData.request).toEqual({ at: 10 });
  expect(cacheData.compacted).toBe(true);
  expect(cacheData.seenTtl).toBe("1h");
  expect(removed).toEqual([TURNS_PREFIX + "old"]);
});

test("history: a failed store read keeps values restored before the failure", async () => {
  reset();
  await restoreTurns({ now: async () => NOW, keys: async () => ["turns:current", "turns:bad", "turns:later"], get: async (key: string) => {
    if (key === "turns:current") return { readings: [{ tokens: 4, window: 100 }] };
    throw new Error("unreadable");
  }, remove: async () => { throw new Error("must not delete"); } }, () => "turns:current");
  expect(contextData.readings).toEqual([{ tokens: 4, window: 100 }]);
});

test("history: saves the existing shape and does not read the clock without a key", async () => {
  reset();
  const writes: any[] = [];
  let clockReads = 0;
  const deps = { now: async () => { clockReads++; return NOW; }, set: async (...args: any[]) => { writes.push(args); } };
  await saveTurns(deps, () => null);
  expect(clockReads).toBe(0);
  await saveTurns(deps, () => "turns:current");
  expect(writes).toEqual([["turns:current", { at: NOW, readings: [], cache: null, compacted: false, seenTtl: null }]]);
});

test("history: publishing keeps newer shared limits and adoption only takes newer valid readings", async () => {
  reset();
  const writes: any[] = [];
  const list = [{ kind: "seven_day" }, { kind: "five_hour" }];
  await shareLimits({ now: async () => NOW, get: async () => ({ at: NOW + 1 }), set: async (...args: any[]) => { writes.push(args); } }, list);
  expect(writes).toEqual([]);
  expect(limitData.reading).toEqual({ at: NOW, list: [...list].reverse() });
  await adoptShared(async () => ({ at: NOW, list: [] }));
  expect(limitData.reading.list.length).toBe(2);
  await adoptShared(async () => ({ at: NOW + 1, list }));
  expect(limitData.reading).toEqual({ at: NOW + 1, list: [...list].reverse() });
});

test("suggestions: a detached reply from an older turn is dropped", async () => {
  reset();
  let finish: any;
  let forkStarted: any;
  const started = new Promise((resolve) => { forkStarted = resolve; });
  const reply = new Promise((resolve) => { finish = resolve; });
  const suggested: any[] = [];
  const shown: any[] = [];
  startSuggestions({ show: (state: any) => { shown.push(state); show(state); }, commands: async () => [], fork: () => { forkStarted(); return reply; }, log: () => {}, suggest: async (value: any) => { suggested.push(value); } }, { reason: "answer", answer: "a".repeat(80), turnId: "old" });
  expect(suggestionData.current).toEqual({ kind: "loading", turnId: "old" });
  await started;
  show({ kind: "loading", turnId: "new" });
  finish({ isAnswered: true, text: JSON.stringify(ITEMS) });
  await reply;
  await Promise.resolve();
  expect(suggestionData.current).toEqual({ kind: "loading", turnId: "new" });
  expect(shown.length).toBe(1);
  expect(suggested).toEqual([]);
});

test("suggestions: command listing failure still offers slash prompts and suggests the first", async () => {
  reset();
  let suggested: any;
  const done = new Promise((resolve) => { suggested = resolve; });
  startSuggestions({ show, commands: async () => { throw new Error("unavailable"); }, fork: async () => ({ isAnswered: true, text: '[{"prompt":"/unknown next"}]' }), log: () => {}, suggest: async (value: any) => { suggested(value); } }, { reason: "answer", answer: "a".repeat(80), turnId: "turn" });
  expect(await done).toEqual({ text: "/unknown next" });
  expect(suggestionData.current.kind).toBe("offer");
});

test("suggestions: picks keep their order, ignore stale indexes and hide before filling", async () => {
  reset();
  show({ kind: "offer", items: ITEMS, picked: [] });
  togglePick(show, 1);
  togglePick(show, 0);
  togglePick(show, 2);
  expect(suggestionData.current.picked).toEqual([1, 0]);
  const calls: any[] = [];
  writePicks({ show, fill: async (value: any) => { calls.push([suggestionData.current.kind, value]); return { isFilled: false }; }, toast: (text: string) => { calls.push(text); } });
  await Promise.resolve();
  expect(calls).toEqual([["hidden", { text: "Do these in order, one after the other:\n1. Review the diff\n2. Run the tests" }], "could not fill the prompt box"]);
});

test("info refresh: uses sequential git probes with the same exclusions and clears effort on a model switch", async () => {
  reset();
  infoData.sessionModel = "old";
  infoData.current.effort = "high";
  const calls: any[] = [];
  const outputs = [" topic \n", " M file\n?? other\n", "5\t2\tfile\n-\t-\timage\n"];
  const changed = await refreshInfo({ cwd: async () => "/work/project/", run: async (argv: string[], options: any) => { calls.push([argv, options]); return { exitCode: 0, stdout: outputs.shift() }; }, model: async () => "new" });
  expect(changed).toBe(true);
  expect(infoData.current).toEqual({ model: "new", effort: "", speed: null, dir: "project", branch: "topic", files: 2, added: 5, removed: 2 });
  expect(calls).toEqual([
    [["git", "--no-optional-locks", "branch", "--show-current"], { cwd: "/work/project/", timeoutMs: 3000 }],
    [["git", "--no-optional-locks", "status", "--porcelain"], { cwd: "/work/project/", timeoutMs: 3000 }],
    [["git", "--no-optional-locks", "diff", "HEAD", "--numstat", "--", ".", ...["*.unity", "*.prefab", "*.asset", "*.meta", "*.mat", "*.anim", "*.controller", "*.physicMaterial", "*.lighting"].map((g) => `:(exclude)${g}`)], { cwd: "/work/project/", timeoutMs: 3000 }],
  ]);
});

test("info refresh: a probe exception preserves partial updates and skips model lookup", async () => {
  reset();
  infoData.current.branch = "previous";
  infoData.current.files = 3;
  let modelReads = 0;
  expect(await refreshInfo({ cwd: async () => "/work/current", run: async () => { throw new Error("timeout"); }, model: async () => { modelReads++; return "new"; } })).toBe(true);
  expect(infoData.current.dir).toBe("current");
  expect(infoData.current.branch).toBe("previous");
  expect(infoData.current.files).toBe(3);
  expect(modelReads).toBe(0);
});

test("render: reads the clock and live agents only for a usage line", async () => {
  reset();
  const reads: string[] = [];
  const deps = { pick: () => {}, write: () => {}, dismiss: () => {}, now: async () => { reads.push("clock"); return NOW; }, agents: () => { reads.push("agents"); return [{ id: "a" }]; } };
  const below = { type: "Text", children: "other mod" };
  expect(await renderHud(elements, { surface: "terminal" }, {}, below, deps)).toBe(below);
  expect(reads).toEqual([]);
  contextData.readings = [{ tokens: 100, window: 1000, percent: 10 }];
  const result = await renderHud(elements, { surface: "terminal" }, {}, below, deps);
  expect(reads).toEqual(["clock", "agents"]);
  expect(result.children[0]).toBe(below);
  expect(JSON.stringify(result)).toContain("1 agent");
});
