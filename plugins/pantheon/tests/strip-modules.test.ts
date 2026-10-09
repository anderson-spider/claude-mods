import { test, expect } from "claude-code/testing";
import { restoreTurns, saveTurns, shareLimits, adoptShared, TURNS_PREFIX } from "../hooks/strip/history";
import { refreshInfo } from "../hooks/strip/info-refresh";
import { renderStrip } from "../hooks/strip/render";
import { contextData, freshContext, HISTORY } from "../hooks/strip/context";
import { cacheData, freshCache } from "../hooks/strip/cache";
import { limitData, freshLimits } from "../hooks/strip/limits";
import { infoData, freshInfo } from "../hooks/strip/info";

const NOW = 1_800_000_000_000;
const KEEP = 8 * 24 * 3_600_000;
const elements = Object.fromEntries(["Box", "Text", "Button"].map((type) => [type, (props: any) => ({ type, props, children: props.children })]));

function reset() {
  Object.assign(contextData, freshContext());
  Object.assign(cacheData, freshCache(), { env: {} });
  limitData.reading = freshLimits();
  Object.assign(infoData, freshInfo());
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

test("info refresh: uses sequential git probes with the same exclusions and clears effort on a model switch", async () => {
  reset();
  infoData.sessionModel = "old";
  infoData.current.effort = "high";
  const calls: any[] = [];
  const outputs = [" topic \n", "/work/repo/.git/worktrees/project\n/work/repo/.git\n", " M file\n?? other\n", "5\t2\tfile\n-\t-\timage\n"];
  const changed = await refreshInfo({ cwd: async () => "/work/project/", run: async (argv: string[], options: any) => { calls.push([argv, options]); return { exitCode: 0, stdout: outputs.shift() }; }, model: async () => "new" });
  expect(changed).toBe(true);
  expect(infoData.current).toEqual({ model: "new", effort: "", speed: "", dir: "repo", branch: "topic", worktree: true, files: 2, added: 5, removed: 2 });
  expect(calls).toEqual([
    [["git", "--no-optional-locks", "branch", "--show-current"], { cwd: "/work/project/", timeoutMs: 3000 }],
    [["git", "--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: "/work/project/", timeoutMs: 3000 }],
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

test("render: reads nothing for an empty strip and keeps what mods below drew", () => {
  reset();
  const below = { type: "Text", children: "other mod" };
  const input = { surface: "terminal", columns: 80, now: NOW, agents: [] as any[], below };
  expect(renderStrip(input, { elements })).toBe(below);
  contextData.readings = [{ tokens: 100, window: 1000, percent: 10 }];
  const result = renderStrip(input, { elements });
  expect(result.children[0]).toBe(below);
  expect(result.children.length).toBe(2);
});
