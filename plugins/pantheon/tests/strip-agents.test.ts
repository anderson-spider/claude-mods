import { test, expect } from "claude-code/testing";
import { agentsFromState, agentsKey, agentsRow, fmtClock, FAIL_GRACE_MS } from "../hooks/strip/agents";
import { width } from "../hooks/strip/runs";
import { agent, NOW } from "./strip-fixtures";

const plain = (runs: { text: string }[]) => runs.map((r) => r.text).join("");

test("git natives keep their role and orange color in the strip", () => {
  const list = agentsFromState(
    [{ id: "git-native", role: "git", type: "pantheon:git", task: "Open PR", ctx: 0, out: 0, steps: 0,
      rounds: [{ startedAt: NOW - 1000, status: "running" }] }], NOW);
  expect(list.map(a => a.role)).toEqual(["git"]);
  const row = agentsRow(list, 116, NOW);
  expect(row.filter(r => r.text === "git").map(r => r.color)).toEqual(["#E8873A"]);
  expect(plain(row)).toContain("Open PR");
});

test("agents row: nothing while idle", () => {
  expect(agentsRow([], 100, NOW)).toEqual([]);
});

test("agents row: a pulse, the role in its color and a clock each, the task while there is room, +N for the rest", () => {
  const list = [agent("explorer", "Map the auth middleware and its callers", 42), agent("executor", "Wire the pace marks", 188), agent("oracle", "Review the cache TTL", 612), agent("designer", "x", 9)];
  const wide = agentsRow(list, 116, NOW);
  expect(plain(wide)).toBe("agents ● explorer Map the auth midd… 0:42 · ● executor Wire the pace ma… 3:08 · ● oracle Review the cache … 10:12 +1");
  expect(wide.find((r) => r.text === "explorer")?.color).toBe("#3FA57D");
  expect(wide.find((r) => r.text === "oracle")?.color).toBe("#A56BD8");
  const mid = agentsRow(list, 76, NOW);
  expect(plain(mid)).toBe("agents ● explorer 0:42 · ● executor 3:08 · ● oracle 10:12 +1");
  const narrow = agentsRow(list, 46, NOW);
  expect(plain(narrow)).toBe("agents 4 running · oldest 10:12");
  for (const room of [116, 76, 46]) expect(width(agentsRow(list, room, NOW))).toBeLessThanOrEqual(room);
});

test("agents row: the pulse is red for a failed agent and its clock stopped when it ended", () => {
  const list = [agent("explorer", "Search", 30), agent("executor", "Patch", 60, { status: "failed", endedAt: NOW - 10_000 })];
  const row = agentsRow(list, 100, NOW);
  expect(row.filter((r) => r.text === "●").map((r) => r.color)).toEqual(["#4CC2A0", "#E5604D"]);
  expect(plain(row)).toContain("0:50");
});

test("agents: the clock reads m:ss, then HhMM", () => {
  expect(fmtClock(42_000)).toBe("0:42");
  expect(fmtClock(612_000)).toBe("10:12");
  expect(fmtClock(3_900_000)).toBe("1h05");
});

test("agents from state: running first by start, every native its own entry, a recent failure only beside a running one", () => {
  const nat = (id: string, role: string, type: string, status: string, extra: any = {}): any => ({ id, role, type, task: id, model: "m", ctx: 0, out: 0, steps: 0, rounds: [{ startedAt: NOW - 1000, status, ...extra }] });
  const natives = [
    nat("early", "explorer", "pantheon:explorer", "running", { startedAt: NOW - 9000 }),
    nat("bad", "executor", "pantheon:executor", "failed", { endedAt: NOW - 2000 }),
    nat("old", "executor", "pantheon:executor", "failed", { endedAt: NOW - FAIL_GRACE_MS - 1 }),
    nat("done", "executor", "pantheon:executor", "done", { endedAt: NOW - 500 }),
    nat("seat", "councillor-alpha", "pantheon:councillor-alpha", "running", { startedAt: NOW - 800 }),
    nat("n1", "other", "Explore", "running", { startedAt: NOW - 600 }),
    nat("n2", "other", "Explore", "running", { startedAt: NOW - 500 }),
    nat("n3", "other", "", "running", { startedAt: NOW - 400 }),
    nat("n4", "oracle", "pantheon:oracle", "running", { startedAt: NOW - 300 }),
    nat("n5", "councillor-beta", "pantheon:councillor-beta", "running", { startedAt: NOW - 200 }),
  ];
  const list = agentsFromState(natives, NOW);
  expect(list.map((a) => a.id)).toEqual(["early", "seat", "n1", "n2", "n3", "n4", "n5", "bad"]);
  expect(list.map((a) => a.role)).toEqual(["explorer", "council", "Explore", "Explore", "agent", "oracle", "council", "executor"]);
  expect(list.map((a) => a.status)).toEqual(Array(7).fill("running").concat("failed"));
  expect(agentsKey(list.slice(0, 2))).toBe("early:running,seat:running");
  // Idle: finished work never makes a summary.
  expect(agentsFromState([nat("n", "other", "Explore", "done", { endedAt: NOW })], NOW)).toEqual([]);
});

test("agents: a failed agent alone does not make a summary", () => {
  const failed: any = { id: "j1", role: "executor", type: "pantheon:executor", task: "x", ctx: 0, out: 0, steps: 0,
    rounds: [{ startedAt: NOW - 5000, endedAt: NOW - 1000, status: "failed" }] };
  expect(agentsFromState([failed], NOW)).toEqual([]);
});

test("agents row: the free width is shared between the tasks, so short ones are never cut at 160 and 120 columns", () => {
  const roomy = [agent("Explore", "Listar arquivos do repositório", 8), agent("Explore", "Listar arquivos de testes", 8), agent("executor", "Wire the pace marks", 70)];
  const row160 = plain(agentsRow(roomy, 156, NOW));
  expect(row160).toContain("Listar arquivos do repositório 0:08");
  expect(row160).toContain("Listar arquivos de testes 0:08");
  expect(row160).toContain("Wire the pace marks 1:10");
  expect(row160).not.toContain("…");
  const short = [agent("Explore", "Listar arquivos", 8), agent("Explore", "Listar testes", 8), agent("executor", "Wire pace marks", 70)];
  const row120 = plain(agentsRow(short, 116, NOW));
  expect(row120).toContain("Listar arquivos 0:08");
  expect(row120).toContain("Listar testes 0:08");
  expect(row120).toContain("Wire pace marks 1:10");
  expect(row120).not.toContain("…");
  // A short task leaves its unused width to a long one.
  const mixed = [agent("explorer", "Map it", 5), agent("executor", "y".repeat(200), 5)];
  const mixedRow = plain(agentsRow(mixed, 116, NOW));
  expect(mixedRow).toContain("Map it 0:05");
  expect(mixedRow.match(/y+/)![0].length).toBeGreaterThan(60);
  // A long task takes only its share: the row still fits and the cut shows.
  const long = [agent("explorer", "x".repeat(200), 5), agent("executor", "y".repeat(200), 5), agent("oracle", "z".repeat(200), 5)];
  const row = agentsRow(long, 116, NOW);
  expect(plain(row)).toContain("…");
  expect(width(row)).toBeLessThanOrEqual(116);
  expect(width(row)).toBeGreaterThan(100);
  // Too little room for a task: it is dropped as before.
  expect(plain(agentsRow(long, 60, NOW))).not.toContain("xxx");
});
