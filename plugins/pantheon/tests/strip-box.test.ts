import { test, expect } from "claude-code/testing";
import { boxLines, drawBox } from "../hooks/strip/box";
import { renderStrip } from "../hooks/strip/render";
import { cacheData, recordRequest } from "../hooks/strip/cache";
import { limitData } from "../hooks/strip/limits";
import { turnData } from "../hooks/strip/receipt";
import { pushReading } from "../hooks/strip/context";
import { infoData } from "../hooks/strip/info";
import { cellWidth } from "../hooks/theme";
import { D, H, NOW, agent, elements, input, plain, reset, seed, texts, windowOf } from "./strip-fixtures";

const WIDTHS = [120, 80, 50];
const AGENTS = [agent("explorer", "Map the auth middleware and its callers", 42), agent("fixer", "Wire the new pace marks into limits", 188), agent("oracle", "Review the cache TTL inference for edge cases", 612)];

// The burning state: 71% used with the clock at 38%, climbing 12 points in the last ten minutes.
function burning() {
  seed({ limits: [windowOf("five_hour", 71, 0.38), windowOf("seven_day", 58, 0.49)] });
  limitData.history = { five_hour: { points: [{ at: NOW - 10 * 60_000, used: 59 }, { at: NOW - 6 * 60_000, used: 65 }] } };
}

test("box: every line, borders included, has exactly the width of the terminal (⚡ ● ▰▱ ↯ and … counted in cells)", () => {
  const states: [string, () => void, any][] = [
    ["idle", () => seed(), {}],
    ["working with agents", () => seed(), { isWorking: true, agents: [...AGENTS, agent("designer", "x", 9), agent("Explore", "y", 3)] }],
    ["burning", burning, { isWorking: true }],
    ["a failed agent", () => seed(), { isWorking: true, agents: [agent("fixer", "Patch", 60, { status: "failed", endedAt: NOW - 5000 }), agent("explorer", "Look", 30)] }],
  ];
  for (const columns of WIDTHS) {
    for (const [name, setup, extra] of states) {
      setup();
      const lines = plain(columns, extra);
      expect(lines.length).toBeGreaterThanOrEqual(4);
      for (const line of lines) expect([name, columns, cellWidth(line), line]).toEqual([name, columns, columns, line]);
    }
  }
  // The glyphs are really there at 120.
  seed();
  const idle = plain(120).join("\n");
  expect(idle).toContain("⚡fast");
  expect(idle).toContain("○ idle");
  expect(idle).toContain("▰▰▰▱▱");
  const working = plain(120, { isWorking: true, agents: AGENTS }).join("\n");
  expect(working).toContain("● working");
  expect(working).toContain("…");
  burning();
  expect(plain(120).join("\n")).toContain("at recent pace");
  // ⚡ takes two cells: the row holding it is as wide as the others only if it was counted so.
  expect(cellWidth("⚡")).toBe(2);
});

test("box: the 5h and 7d rows line up column for column: same 11-cell bar, same % column, mark and time left", () => {
  // Different digits on purpose: 5% against 29%, a mark on one row only.
  const cases = [
    [windowOf("five_hour", 5, 0.5), windowOf("seven_day", 29, 0.25)],
    [windowOf("five_hour", 100, 0.2), windowOf("seven_day", 7, 0.9)],
    [windowOf("five_hour", 68, 0.41), windowOf("seven_day", 52, 0.49)],
  ];
  for (const limits of cases) {
    for (const columns of WIDTHS) {
      seed({ limits });
      const rows = plain(columns);
      const five = rows.find(r => r.startsWith("│ 5h"))!;
      const seven = rows.find(r => r.startsWith("│ 7d"))!;
      expect(five).toBeDefined();
      expect(seven).toBeDefined();
      // After the label: the bar is the 11 cells up to the first space.
      const barOf = (row: string) => row.slice(5, row.indexOf(" ", 5));
      expect(cellWidth(barOf(five))).toBe(11);
      expect(cellWidth(barOf(seven))).toBe(11);
      expect(barOf(five)).toMatch(/^[━╌│─]{11}$/);
      expect(barOf(seven)).toMatch(/^[━╌│─]{11}$/);
      // The % column, the mark and the time left start at the same cell on both rows.
      const col = (row: string, re: RegExp) => cellWidth(row.slice(0, row.search(re)));
      expect(col(five, /\d/)).toBe(col(seven, /\d/));
      expect(col(five, / · /)).toBe(col(seven, / · /));
      const afterBar = (row: string) => row.slice(5 + 12);
      expect(afterBar(five).search(/[▲▼]|\s{3}/) >= 0).toBe(true);
      // The time left ends at the same cell too: the next " · " (projection) starts at one column.
      if (five.includes("at this pace") && seven.includes("at this pace")) expect(cellWidth(five.slice(0, five.indexOf("at this pace")))).toBe(cellWidth(seven.slice(0, seven.indexOf("at this pace"))));
    }
  }
});

test("box: hud's bar glyphs and text: 5h ━━╌╌╌╌╌╌╌│─ 22% ▼65 · 40m style, at every width", () => {
  seed({ limits: [windowOf("five_hour", 22, 1 - 40 / 300), windowOf("seven_day", 29, 0.25)] });
  for (const columns of WIDTHS) {
    const rows = plain(columns);
    const five = rows.find(r => r.startsWith("│ 5h"))!;
    expect(five).toContain("5h ━━╌╌╌╌╌╌╌│─ 22% ▼65 · 40m");
    const seven = rows.find(r => r.startsWith("│ 7d"))!;
    expect(seven).toContain("7d ━━━│─────── 29% ▲4");
  }
});

test("box: with agents they replace the receipt in the last row, as a pulse, the role and a clock each, and nothing stands above the box", () => {
  seed();
  for (const columns of WIDTHS) {
    const lines = plain(columns, { isWorking: true, agents: AGENTS });
    // Top and bottom borders, the session row, 5h, 7d and the agents row: never more.
    expect(lines.length).toBe(6);
    expect(lines[0].startsWith("╭")).toBe(true);
    expect(lines[5].startsWith("╰")).toBe(true);
    const last = lines[4];
    expect(last).toContain("agents ");
    expect(last).not.toContain("last turn");
    expect(lines.join("\n")).not.toContain("╭─ ●");
  }
  const wide = plain(120, { isWorking: true, agents: AGENTS })[4];
  expect(wide).toContain("● explorer Map the auth middle… 0:42");
  expect(wide).toContain("● fixer");
  expect(wide).toContain("3:08");
  expect(wide).toContain("10:12");
  const mid = plain(80, { isWorking: true, agents: AGENTS })[4];
  expect(mid).toContain("● explorer 0:42 · ● fixer 3:08 · ● oracle 10:12");
  expect(plain(50, { isWorking: true, agents: AGENTS })[4]).toContain("3 running · oldest 10:12");
  // More than three: "+N" for the rest.
  const five = plain(120, { isWorking: true, agents: [...AGENTS, agent("designer", "x", 9), agent("Explore", "y", 3)] })[4];
  expect(five).toContain("+2");
  // Idle again: the receipt is back.
  expect(plain(120)[4]).toContain("last turn 2m37s · 2 agents · 4 edits · 0 errors · +$0.18");
});

test("box: a failed agent's pulse is red and a running one's green", () => {
  seed();
  const tree = drawBox(elements, input(120, { isWorking: true, agents: [agent("explorer", "Look", 30), agent("fixer", "Patch", 60, { status: "failed", endedAt: NOW - 5000 })] }));
  const pulses = texts(tree).filter(t => t.text === "●" && t.color !== undefined);
  // The session row's ● working comes first.
  expect(pulses.map(t => t.color)).toEqual(["#4CC2A0", "#4CC2A0", "#E5604D"]);
});

test("box: the session row drops ⚡fast first, then the diff, the folder, the cost, the status and the cache hit", () => {
  seed();
  const text = (columns: number) => plain(columns)[1];
  let previous = Infinity;
  const gone: string[] = [];
  const probes: [string, string][] = [["fast", "⚡fast"], ["diff", "+182 -37"], ["folder", "claude-mods"], ["cost", "$12.40"], ["status", "idle"], ["hit", "98%"]];
  for (let columns = 130; columns >= 30; columns -= 2) {
    const row = text(columns);
    expect(cellWidth(row)).toBe(columns);
    for (const [name, probe] of probes) if (!row.includes(probe) && !gone.includes(name)) gone.push(name);
    previous = Math.min(previous, columns);
  }
  expect(gone).toEqual(["fast", "diff", "folder", "cost", "status", "hit"]);
  // The model, the context and the cache time never go.
  const narrow = text(30);
  expect(narrow).toContain("Opus 5.5");
  expect(narrow).toContain("62%");
});

test("box: the quota rows give up the projection first, then the bars, then the time left, never the percentage", () => {
  seed({ limits: [windowOf("five_hour", 40, 0.59), windowOf("seven_day", 29, 0.25)] });
  const firsts: Record<string, number> = {};
  for (let columns = 20; columns <= 140; columns++) {
    const rows = plain(columns).filter(r => r.startsWith("│ 5h") || r.startsWith("│ 7d"));
    expect(rows.length).toBe(2);
    expect(rows[0].includes("40%") && rows[1].includes("29%")).toBe(true);
    const joined = rows.join("\n");
    const bars = [...joined.matchAll(/[━╌│─]{11}/g)].length;
    // The bars are 11 cells or absent, on both rows together.
    expect([0, 2]).toContain(bars);
    const has = { left: joined.includes(" · 2h"), bar: bars === 2, proj: joined.includes("at this pace") };
    for (const [k, v] of Object.entries(has)) if (v && firsts[k] === undefined) firsts[k] = columns;
  }
  expect(firsts.left).toBeLessThan(firsts.bar);
  expect(firsts.bar).toBeLessThan(firsts.proj);
  // At 120 and 80 the projection is there; at 50 it is not.
  expect(plain(80).join("\n")).toContain("at this pace: ~68% at reset");
  expect(plain(50).join("\n")).not.toContain("at this pace");
  expect(plain(50).join("\n")).toContain("━");
});

test("box: projections: runs out in X (amber, red when burning or alert), ~N% at reset (calm)", () => {
  seed({ limits: [windowOf("five_hour", 68, 0.41), windowOf("seven_day", 20, 0.4)] });
  const rows = plain(120);
  expect(rows.find(r => r.startsWith("│ 5h"))).toContain("at this pace: 100% in 58m");
  expect(rows.find(r => r.startsWith("│ 7d"))).toContain("at this pace: ~50% at reset");
  burning();
  const hot = plain(120).find(r => r.startsWith("│ 5h"))!;
  expect(hot).toMatch(/at recent pace: 100% in \d+m ↯/);
  // No projection at 0% used.
  seed({ limits: [windowOf("five_hour", 0, 0.5), windowOf("seven_day", 0, 0.5)] });
  expect(plain(120).join("\n")).not.toContain("at this pace");
});

test("box: tones: amber ▲ ahead of the pace, red past 15 points, green ▼ behind; paceStart forgives a small lead", () => {
  seed({ limits: [windowOf("five_hour", 68, 0.41), windowOf("seven_day", 52, 0.49)] });
  const marks = (extra = {}) => Object.fromEntries(texts(drawBox(elements, input(120, extra))).filter(t => /^[▲▼]\d+$/.test(t.text)).map(t => [t.text, t.color]));
  expect(marks()).toEqual({ "▲27": "#ff6b6b", "▲3": "#e0a030" });
  limitData.paceStart = 5;
  expect(marks()).toEqual({ "▲27": "#ff6b6b" });
  limitData.paceStart = 0;
  seed({ limits: [windowOf("five_hour", 10, 0.5), windowOf("seven_day", 90, 0.5)] });
  expect(marks()).toEqual({ "▼40": "#6fcf97", "▲40": "#ff6b6b" });
  // The use turns red from 90%.
  const pct = texts(drawBox(elements, input(120))).find(t => t.text === "90%");
  expect(pct.color).toBe("#ff6b6b");
});

test("box: the clock mark sits at the end of the bar when the window is over", () => {
  seed({ limits: [windowOf("five_hour", 30, 0.999), windowOf("seven_day", 30, 0.2)] });
  const five = plain(120).find(r => r.startsWith("│ 5h"))!;
  expect(five.slice(5, 16)).toMatch(/^[━╌─]{10}│$/);
});

test("box: a window without a length has a bar with no clock mark, still 11 cells wide", () => {
  seed({ limits: [{ kind: "spend_limit", percentUsed: 40 }] });
  const row = plain(120).find(r => r.startsWith("│ $"))!;
  expect(row.slice(4, 15)).toBe("━━━━────── ");
});

test("box: a window that already reset is hidden, and without limits there are no quota rows", () => {
  seed({ limits: [{ kind: "five_hour", percentUsed: 80, resetsAt: new Date(NOW - 60_000).toISOString() }, windowOf("seven_day", 59, 0.57)] });
  const rows = plain(120).join("\n");
  expect(rows).not.toContain("5h");
  expect(rows).toContain("7d");
  seed({ limits: [] });
  expect(plain(120).join("\n")).not.toMatch(/\b(5h|7d)\b/);
});

test("box: the last-turn receipt: duration, agents, edits, errors and the cost; tokens without a ledger", () => {
  seed();
  turnData.last = { ms: 312_000, agents: 3, edits: 9, errors: 1, usd: 1.42, ctx: 41_000 };
  expect(plain(120)[4]).toContain("last turn 5m12s · 3 agents · 9 edits · 1 error · +$1.42");
  turnData.last = { ms: 42_000, agents: 1, edits: 1, errors: 0, usd: null, ctx: 6300 };
  expect(plain(120)[4]).toContain("last turn 42s · 1 agent · 1 edit · 0 errors · +6.3k ctx");
  // Narrow: the cheap parts go, the duration and the cost stay.
  turnData.last = { ms: 157_000, agents: 2, edits: 4, errors: 0, usd: 0.18, ctx: 0 };
  const narrow = plain(50)[4];
  expect(narrow).toContain("2m37s");
  expect(narrow).toContain("+$0.18");
  // Before the first turn the row is not drawn.
  turnData.last = null;
  expect(plain(120).length).toBe(5);
});

test("box: the session row: session cost, model and effort, working or idle, context gauge, cache and the changed files", () => {
  seed();
  const row = plain(120)[1];
  expect(row).toContain("Opus 5.5·medium · ○ idle · ctx ▰▰▰▱▱  62% · cache 55m 98% · $12.40 · claude-mods flightdeck* · +182 -37 · ⚡fast");
  expect(plain(120, { isWorking: true })[1]).toContain("● working");
  // A clean tree: green branch with no star and no diff.
  infoData.current.files = 0;
  const clean = plain(120)[1];
  expect(clean).toContain("claude-mods flightdeck ·");
  expect(clean).not.toContain("flightdeck*");
  expect(clean).not.toContain("+182");
  // A linked worktree.
  infoData.current.worktree = true;
  expect(plain(120)[1]).toContain("⎇wt");
});

test("box: context weather colors by the share of the window", () => {
  seed({ ctx: 80 });
  const gauge = texts(drawBox(elements, input(120))).find(t => t.text === "▰▰▰▰");
  expect(gauge.color).toBe("#c678dd");
  seed({ ctx: 95 });
  expect(texts(drawBox(elements, input(120))).find(t => t.text === "▰▰▰▰▰").color).toBe("#ff6b6b");
});

test("box: the cache: time left and share read, yellow with what is at stake under a sixth of the lifetime", () => {
  seed();
  expect(plain(120)[1]).toContain("cache 55m 98%");
  // 1 hour lifetime, 5 minutes left.
  cacheData.request.at = NOW - 55 * 60_000;
  const soon = plain(120)[1];
  expect(soon).toContain("cache 5m 620k at stake 98%");
  const tree = drawBox(elements, input(120));
  expect(texts(tree).find(t => t.text === "5m").color).toBe("#e0a030");
});

test("box: an expired cache is red with what the next message writes and the way out", () => {
  seed({ ctx: 29 });
  pushReading({ tokens: 289_000, window: 1_000_000, percent: 29 });
  cacheData.request.at = NOW - 2 * H;
  const row = plain(120)[1];
  expect(row).toContain("cache expired · 289k to rewrite · /compact");
  pushReading({ tokens: 320_000, window: 1_000_000, percent: 32 });
  expect(plain(120)[1]).toContain("cache expired · 320k to rewrite · new thread");
  pushReading({ tokens: 289_000, window: 1_000_000, percent: 29 });
  const tree = drawBox(elements, input(120));
  expect(texts(tree).find(t => t.text === "expired").color).toBe("#ff6b6b");
  pushReading({ tokens: 150_000, window: 1_000_000, percent: 15 });
  expect(plain(120)[1]).toContain("cache expired · 150k to rewrite · /compact");
  pushReading({ tokens: 90_000, window: 1_000_000, percent: 9 });
  expect(plain(120)[1]).toContain("cache expired · $12.40");
  // Narrow: the alert stays, its detail goes.
  const narrow = plain(50)[1];
  expect(narrow).toContain("cache expired");
  expect(narrow).not.toContain("to rewrite");
});

test("box: a miss names its cause, yellow", () => {
  seed();
  recordRequest(NOW - 60_000, { model: "claude-sonnet-5-5", input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 99_700 }, "claude-sonnet-5-5");
  expect(plain(120)[1]).toContain("0% missed · model changed");
});

test("box: nothing is drawn without anything to show, and an empty box is not a blank one", () => {
  reset();
  expect(boxLines(input(120))).toEqual([]);
  expect(drawBox(elements, input(120))).toBeNull();
});

test("renderStrip: keeps what mods below drew above the box and returns it alone when there is nothing", () => {
  reset();
  const below = { type: "Text", children: "other mod" };
  const empty = renderStrip({ surface: "terminal", columns: 120, now: NOW, agents: [], below }, { elements });
  expect(empty).toBe(below);
  seed();
  const out = renderStrip({ surface: "terminal", columns: 120, now: NOW, isWorking: true, agents: [], below }, { elements });
  expect(out.children[0]).toBe(below);
  expect(out.children[1].props.key).toBe("strip");
  expect(texts(out).some(t => t.text === " working")).toBe(true);
  const bare = renderStrip({ surface: "terminal", columns: 120, now: NOW, agents: [] }, { elements });
  expect(bare.props.key).toBe("strip");
});
