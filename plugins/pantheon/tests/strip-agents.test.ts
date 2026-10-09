import { test, expect } from "claude-code/testing";
import { agentLines, agentsFromRoster, agentsKey, drawAgents, fmtClock, CARD_MIN_COLUMNS, FAIL_GRACE_MS, type AgentView } from "../hooks/strip/agents";
import { renderStrip } from "../hooks/strip/render";
import { contextData, freshContext } from "../hooks/strip/context";
import { infoData, freshInfo } from "../hooks/strip/info";
import { limitData, freshLimits } from "../hooks/strip/limits";
import { noteStep, tickStrip, configureStrip, type StripHost } from "../hooks/strip/state";
import { cacheData, freshCache } from "../hooks/strip/cache";
import { ROLE_COLOR, OK, BAD, cellWidth } from "../hooks/theme";
import { elements } from "./strip-helpers";

const NOW = 1_800_000_000_000;
const A = (role: string, task: string, s: number, extra: Partial<AgentView> = {}): AgentView => ({ id: `${role}-${s}`, role, task, startedAt: NOW - s * 1000, status: "running", ...extra });
const FIVE = [A("explorer", "Map the auth middleware and its callers", 42), A("fixer", "Wire the pace marks into limits", 188), A("oracle", "Review the cache TTL inference", 612), A("designer", "Draft the strip layout", 95), A("librarian", "Check Ink border docs", 7)];
const plain = (rows: { text: string }[][]) => rows.map((r) => r.map((x) => x.text).join(""));

function reset() {
  Object.assign(contextData, freshContext());
  Object.assign(cacheData, freshCache(), { env: {} });
  limitData.reading = freshLimits();
  Object.assign(infoData, freshInfo());
}

// Every Text of a tree with its props, in order.
function runs(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => runs(n, out)); return out; }
  if (node.type === "Text") out.push({ text: node.text, ...node.props });
  runs(node.children, out);
  return out;
}

test("agents: nothing is drawn while idle", () => {
  expect(agentLines([], 120, NOW)).toEqual([]);
  expect(drawAgents(elements, [], 120, NOW)).toBeNull();
});

test("agents: a failed agent alone does not make a summary", () => {
  const roster: any = { slots: [{ name: "fixer", instances: [{ id: "j1", task: "x", isActive: false, status: "error", startedAt: NOW - 5000, endedAt: NOW - 1000, rounds: [] }] }], others: [] };
  expect(agentsFromRoster(roster, NOW)).toEqual([]);
});

test("agents: one running card with the role in the border, the task inside and the clock", () => {
  const rows = plain(agentLines([A("fixer", "Wire the pace marks", 188)], 120, NOW));
  expect(rows.length).toBe(3);
  expect(rows[0]).toContain("╭─ ● fixer ");
  expect(rows[0]).toContain(" 3:08 ─╮");
  expect(rows[1]).toContain("│ Wire the pace marks");
  expect(rows[2]).toContain("╰");
  // Every card row is as wide as the others.
  expect(new Set(rows.map((r) => cellWidth(r))).size).toBe(1);
});

test("agents: three cards side by side, each in its role color", () => {
  const three = FIVE.slice(0, 3);
  const lines = agentLines(three, 120, NOW);
  expect(lines.length).toBe(3);
  const tops = runs(drawAgents(elements, three, 120, NOW)).filter((r) => r.text.includes("explorer") || r.text.includes("fixer") || r.text.includes("oracle"));
  expect(tops.map((r) => r.color)).toEqual([ROLE_COLOR.explorer, ROLE_COLOR.fixer, ROLE_COLOR.oracle]);
  for (const row of plain(lines)) expect(cellWidth(row)).toBeLessThanOrEqual(118);
});

test("agents: more than three show three cards and +N more", () => {
  const rows = plain(agentLines(FIVE, 120, NOW));
  expect(rows.length).toBe(3);
  expect(rows.join("\n")).not.toContain("designer");
  expect(rows[1]).toContain("+2 more");
});

test("agents: below 90 columns the cards become one-line rows", () => {
  expect(CARD_MIN_COLUMNS).toBe(90);
  const wide = plain(agentLines(FIVE.slice(0, 3), 90, NOW));
  expect(wide.length).toBe(3);
  expect(wide[0]).toContain("╭");
  for (const columns of [89, 80, 50]) {
    const rows = plain(agentLines(FIVE.slice(0, 3), columns, NOW));
    expect(rows.length).toBe(3);
    expect(rows.join("")).not.toContain("╭");
    expect(rows[0]).toMatch(/^ ● explorer /);
    expect(rows[0]).toMatch(/0:42$/);
    for (const row of rows) expect(cellWidth(row)).toBeLessThanOrEqual(columns - 2);
  }
  // Stacked, "+N more" takes a row of its own.
  const stacked = plain(agentLines(FIVE, 50, NOW));
  expect(stacked.length).toBe(4);
  expect(stacked[3].trim()).toBe("+2 more");
});

test("agents: the pulse is green while running and red on failure", () => {
  const list = [A("explorer", "Search", 30), A("fixer", "Patch", 60, { status: "failed", endedAt: NOW - 10_000 })];
  for (const columns of [120, 50]) {
    const pulses = runs(drawAgents(elements, list, columns, NOW)).filter((r) => r.text === "●");
    expect(pulses.map((r) => r.color)).toEqual([OK, BAD]);
  }
  // A failed agent's clock stopped when it ended.
  expect(plain(agentLines([list[1]], 50, NOW))[0]).toMatch(/0:50$/);
});

test("agents: the clock reads m:ss, then HhMM", () => {
  expect(fmtClock(42_000)).toBe("0:42");
  expect(fmtClock(612_000)).toBe("10:12");
  expect(fmtClock(3_900_000)).toBe("1h05");
});

test("agents from the roster: running first by start, a recent failure only beside a running one", () => {
  const inst = (id: string, extra: any = {}) => ({ id, task: id, isActive: true, status: "running", startedAt: NOW - 1000, rounds: [], ...extra });
  const roster: any = {
    slots: [
      { name: "orchestrator", instances: [inst("main")] },
      { name: "explorer", instances: [inst("late", { startedAt: NOW - 1000 }), inst("early", { startedAt: NOW - 9000 })] },
      { name: "fixer", instances: [inst("bad", { isActive: false, status: "failed", endedAt: NOW - 2000 }), inst("old", { isActive: false, status: "error", endedAt: NOW - FAIL_GRACE_MS - 1 }), inst("done", { isActive: false, status: "done" })] },
    ],
    others: [inst("native", { startedAt: NOW - 500 })],
  };
  const list = agentsFromRoster(roster, NOW);
  expect(list.map((a) => a.id)).toEqual(["early", "late", "native", "bad"]);
  expect(list.map((a) => a.role)).toEqual(["explorer", "explorer", "agent", "fixer"]);
  expect(list.map((a) => a.status)).toEqual(["running", "running", "running", "failed"]);
  expect(agentsKey(list)).toBe("early:running,late:running,native:running,bad:failed");
  // Idle: the orchestrator and finished work never make a summary.
  roster.slots[1].instances = [];
  roster.others = [];
  expect(agentsFromRoster(roster, NOW)).toEqual([]);
});

test("strip: the summary sits above the info, usage and limits rows and below other mods", () => {
  reset();
  infoData.current.model = "claude-opus-5-5";
  infoData.current.effort = "medium";
  contextData.readings = [{ tokens: 100_000, window: 1_000_000, percent: 10 }];
  limitData.reading = { at: NOW, list: [{ kind: "five_hour", percentUsed: 20, resetsAt: new Date(NOW + 3_600_000).toISOString() }] };
  const below = { type: "Text", children: "other mod" };
  const tree = renderStrip({ surface: "terminal", columns: 120, now: NOW, agents: FIVE.slice(0, 3), below }, { elements });
  const kids = tree.children;
  expect(kids[0]).toBe(below);
  expect(kids.length).toBe(4);
  expect(kids[1].props.key).toBe("agents");
  expect(kids[2].props.key).toBe("info");
  expect(kids[3].props.flexDirection).toBe("column");
  // Idle: no agents element at all.
  const idle = renderStrip({ surface: "terminal", columns: 120, now: NOW, agents: [], below }, { elements });
  expect(idle.children.length).toBe(3);
  expect(idle.children.some((c: any) => c.props?.key === "agents")).toBe(false);
});

test("strip: with agents the summary is 3 rows, plus one for +N more when stacked", () => {
  const rowsOf = (agents: AgentView[], columns: number) => (drawAgents(elements, agents, columns, NOW) as any).children.length;
  expect(rowsOf(FIVE, 120)).toBe(3);
  expect(rowsOf(FIVE.slice(0, 3), 50)).toBe(3);
  expect(rowsOf(FIVE, 50)).toBe(4);
});

test("info: ⚡fast follows the last request's speed and is the first part to drop", () => {
  reset();
  infoData.current = { ...infoData.current, model: "claude-opus-5-5", effort: "medium", dir: "claude-mods", branch: "feat/strip", worktree: false, files: 0, added: 0, removed: 0 };
  expect(noteStep({ model: "claude-opus-5-5", effort: "medium" }, { usage: { speed: "fast", input_tokens: 1 } }, NOW)).toBe(true);
  expect(infoData.current.speed).toBe("fast");
  const textsAt = (columns: number) => runs(renderStrip({ surface: "terminal", columns, now: NOW, agents: [] }, { elements })).map((r) => r.text);
  expect(textsAt(120)).toContain("⚡fast");
  // Dropped before the effort, the folder or the branch.
  const width = 2 + "Opus 5.5".length + "·medium".length + 3 + "claude-mods".length + 3 + "feat/strip".length;
  const narrow = textsAt(width + 2);
  expect(narrow).not.toContain("⚡fast");
  expect(narrow).toContain("·medium");
  expect(narrow).toContain("claude-mods");
  expect(narrow).toContain("feat/strip");
  noteStep({ model: "claude-opus-5-5" }, { usage: { speed: "standard", input_tokens: 1 } }, NOW);
  expect(textsAt(120)).not.toContain("⚡fast");
});

test("state: a step without usage changes nothing, and the tick redraws only on a change", async () => {
  reset();
  configureStrip({ paceStart: 0 });
  expect(noteStep({ model: "m" }, undefined, NOW)).toBe(false);
  const host: StripHost = {
    now: async () => NOW, sessionId: async () => "s", cwd: async () => { throw new Error("none"); }, model: async () => "",
    run: async () => ({ exitCode: 1, stdout: "" }), usage: async () => ({ rateLimits: [] }),
    storeKeys: async () => [], storeGet: async () => undefined, storeSet: async () => undefined, storeDelete: async () => undefined,
  };
  // The first tick sees the countdown text for the first time.
  expect(await tickStrip(host)).toBe(true);
  expect(await tickStrip(host)).toBe(false);
  expect(await tickStrip(host, true)).toBe(true);
});
