import { test, expect, mock } from "claude-code/testing";

// October 2, 2026, 13:00 UTC.
const NOW = Date.UTC(2026, 9, 2, 13, 0);
// The 5-hour reset time is shown in the machine's time zone.
const at = (ms: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
const LIMITS = [
  // 7 days: 59% used, 4 of 7 days elapsed (57%): slightly ahead, yellow.
  { kind: "seven_day", percentUsed: 59, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
  // 5 hours: 32% used, 2 of 5 hours elapsed (40%): behind time, green.
  { kind: "five_hour", percentUsed: 32, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
];

// below: what a mod placed after this one draws under the line.
function world(on: any, env: Record<string, string> = {}, stored: Record<string, unknown> = {}, below?: string) {
  const clock = mock.clock(on, { now: NOW });
  mock.store(on, stored);
  mock.env(on, env);
  on("session.id", () => ({ value: "session-1" }));
  on("session.start", (_$: any, e: any) => ({ cwd: e.cwd ?? "/tmp" }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.render", ($: any, e: any) => (below ? $.ui.resolve(e).Text({ children: below }) : $.ui.resolve(e).Box({ children: [] })));
  return clock as any;
}

function withUsage(on: any, rateLimits: unknown[], context = { tokens: 107_000, window: 1_000_000, percent: 11 }) {
  on("session.usage", () => ({ value: { startedAt: NOW, context, rateLimits } }));
}

async function band($: any, surface: "terminal" | "desktop", columns = 200) {
  const ui = await $.ui.mount({ plugin: "hud", surface, component: "AbovePrompt", props: { bodyColumns: columns } as any });
  // The hover cards' lines are hidden until hovered: left out of the band's texts.
  const hidden = ((await ui.findAll({ type: "Box" })) as any[])
    .filter((b) => b.props?.position === "absolute")
    .flatMap((b) => ((b.children ?? []) as any[]).map((t) => strings(t).join("")));
  const texts: string[] = [];
  for (const t of (await ui.findAll({ type: "Text" })) as any[]) {
    const i = hidden.indexOf(t.text);
    if (i >= 0) hidden.splice(i, 1);
    else texts.push(t.text);
  }
  return { ui, texts };
}

// The hover cards drawn inside the pills, as element descriptions.
async function cardNodes(ui: any): Promise<any[]> {
  const pills = ((await ui.findAll({ type: "Box" })) as any[]).filter((b) => b.key);
  return pills.flatMap((p) => ((p.children ?? []) as any[]).filter((c) => c && typeof c === "object" && c.props?.position === "absolute"));
}

// Every string beneath a drawn element description, in order.
function strings(node: any): string[] {
  if (node == null || node === false) return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(strings);
  return strings(node.children ?? node.props?.children);
}

// The hover card of a pill (by its key), its lines joined by newlines; null without one.
async function cardOf(ui: any, pillKey: string): Promise<string | null> {
  const pill: any = await ui.find({ type: "Box", key: pillKey });
  const kids = (pill?.children ?? []) as any[];
  const card = kids.find((c) => c && typeof c === "object" && c.props?.position === "absolute");
  if (!card) return null;
  const lines = ((card.children ?? card.props?.children ?? []) as any[]).map((t) => strings(t).join(""));
  return lines.join("\n");
}

for (const surface of ["terminal", "desktop"] as const) {
  test(`band ${surface}`, async ($, on) => {
    world(on);
    withUsage(on, LIMITS);
    await $.session.start({ source: "startup", cwd: "/tmp" } as any);
    const { ui, texts } = await band($, surface);
    // The context in tokens alone; the weather word goes to the icon's tooltip.
    expect(texts).toContain("107k");
    expect(texts).not.toContain("11% context");
    expect(texts).toContain("5h");
    // The bar says how much is used: no percentage beside it.
    expect(texts).toContain("█");
    expect(texts).not.toContain("32%");
    const dot = surface === "terminal" ? "· " : "";
    // The time left alone; the reset time is in the clock's tooltip.
    expect(texts).toContain(`${dot}3h00`);
    expect(texts).not.toContain(`${dot}3h00 → ${at(NOW + 3 * 3_600_000)}`);
    expect(texts).not.toContain("59%");
    expect(texts).toContain(`${dot}3d00h`);
    // No request yet: the cache block waits, no cost without a ledger. In the app the bolt stands for the word.
    if (surface === "terminal") expect(texts).toContain("cache");
    expect(texts).toContain("—");
    if (surface === "desktop") {
      const svgs = (await ui.findAll({ type: "Svg" })) as any[];
      // The weather word sits in the context pill's hover card; no drawing is interactive any more
      // (the app shows no SVG tooltip).
      expect(svgs.some((s) => s.props?.alt === "Clear · 11% of 1M")).toBe(true);
      expect(await cardOf(ui, "context")).toBe("Clear · 11% of 1M");
      for (const s of svgs) expect(s.props?.isInteractive).toBeFalsy();
      // No request yet: no card on the cache pill.
      expect(await cardOf(ui, "cache")).toBeNull();
      // Hover cards: hidden, revealed by the pill's hover, in the theme's colors.
      const cards = await cardNodes(ui);
      expect(cards.length).toBeGreaterThan(0);
      for (const c of cards) {
        expect(c.props?.display).toBe("none");
        expect((c.hover ?? c.props?.hover)?.display).toBe("flex");
        expect(c.props?.backgroundColor).toBe("background");
        expect(c.props?.key).toBeUndefined();
      }
      // Pills: tinted and rounded, without the border's vertical padding.
      const pills = ((await ui.findAll({ type: "Box" })) as any[]).filter((b) => b.props?.backgroundColor && b.props?.position !== "absolute");
      expect(pills.length).toBe(4);
      for (const p of pills) {
        expect(p.props?.borderStyle).toBe("round");
        expect(p.props?.paddingY).toBe(0);
      }
    } else {
      expect(texts).toContain("☀");
      expect(texts).not.toContain("Clear");
    }
    // 5 hours before 7 days, whatever the order received.
    expect(texts.indexOf("5h")).toBeLessThan(texts.indexOf("7d"));
    // A single reading: no turns chart yet.
    expect(texts).not.toContain("turns");
  });
}

test("keeps what later mods draw, above the suggestions and the line", async ($, on) => {
  world(on, {}, {}, "drawn after this mod");
  withUsage(on, LIMITS);
  suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("drawn after this mod");
  expect(texts.indexOf("drawn after this mod")).toBeLessThan(texts.indexOf("next:"));
  expect(texts.indexOf("next:")).toBeLessThan(texts.indexOf("107k"));
});

for (const surface of ["terminal", "desktop"] as const) {
  test(`pace mark: ▲ ahead in amber, ▼ behind in green, with the gap in points ${surface}`, async ($, on) => {
    world(on);
    withUsage(on, LIMITS);
    await $.session.start({ source: "startup", cwd: "/tmp" } as any);
    const { ui, texts } = await band($, surface);
    // 7 days: 59% used against 57% of the time elapsed, 2 points ahead. 5 hours: 32% against 40%, 8 behind.
    expect(texts).toContain("▲ 2");
    expect(texts).toContain("▼ 8");
    // The 5-hour window comes first: its mark sits between "5h" and "7d", the 7-day mark after "7d".
    expect(texts.indexOf("5h")).toBeLessThan(texts.indexOf("▼ 8"));
    expect(texts.indexOf("▼ 8")).toBeLessThan(texts.indexOf("7d"));
    expect(texts.indexOf("7d")).toBeLessThan(texts.indexOf("▲ 2"));
    const ahead: any = await ui.find({ type: "Text", text: "▲ 2" });
    expect(ahead?.props?.bold).toBe(true);
    expect(ahead?.props?.color).toBe("#a8690a");
    const behind: any = await ui.find({ type: "Text", text: "▼ 8" });
    expect(behind?.props?.bold).toBe(true);
    // The terminal's green is a hex; the app keeps the theme's "green".
    expect(behind?.props?.color).toBe(surface === "terminal" ? "#6fcf97" : "green");
  });
}

test("pace mark: red past the pace alert, green when far behind", async ($, on) => {
  world(on);
  withUsage(on, [
    // 7 days: 90% used, 4 of 7 days elapsed: far ahead, red.
    { kind: "seven_day", percentUsed: 90, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
    // 5 hours: 10% used, 2 of 5 hours elapsed: behind time.
    { kind: "five_hour", percentUsed: 10, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
  ]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { ui, texts } = await band($, "terminal");
  expect(texts).toContain("▲ 33");
  expect(texts).toContain("▼ 30");
  const ahead: any = await ui.find({ type: "Text", text: "▲ 33" });
  expect(ahead?.props?.color).toBe("#ff6b6b");
  const behind: any = await ui.find({ type: "Text", text: "▼ 30" });
  expect(behind?.props?.color).toBe("#6fcf97");
});

test("pace mark: none for a window without a length", async ($, on) => {
  world(on);
  withUsage(on, [{ kind: "spend_limit", percentUsed: 40 }]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("$");
  expect(texts).toContain("█");
  expect(texts.some((t) => /^[▲▼]/.test(t))).toBe(false);
});

test("terminal: the line has no background panel", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { ui } = await band($, "terminal");
  const boxes = (await ui.findAll({ type: "Box" })) as any[];
  expect(boxes.some((b) => b.props?.backgroundColor)).toBe(false);
});

// 7 days: 59% used against 57% of the time, 2 points ahead: flagged by default, ignored from a start of 5.
test("pace start: a lead inside the start is not flagged", { options: { paceStart: 5 } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("7d");
  // 2 points ahead, inside the start: on pace, no mark; still 8 behind on the other window.
  expect(texts.some((t) => t.startsWith("▲"))).toBe(false);
  expect(texts.some((t) => t.startsWith("▲"))).toBe(false);
  expect(texts).toContain("▼ 8");
});

test("pace start: a lead beyond the start is flagged", { options: { paceStart: 1 } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("▲ 2");
});

test("narrow terminal: gives up the cache extras, then the bars, and the reset times last", async ($, on) => {
  // The 5-minute lifetime is the one with extras (its label) to give up.
  world(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" });
  withUsage(on, LIMITS);
  engineStep(on, [HIT]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, HIT);
  const seen: string[] = [];
  for (let columns = 40; columns <= 200; columns += 2) {
    const { texts } = await band($, "terminal", columns);
    const bar = texts.includes("█");
    const reset = texts.includes("· 3h00") && texts.includes("· 3d00h");
    const extras = texts.some((t) => t.includes("TTL"));
    // Each piece of detail only ever appears when every more important one does.
    if (extras) expect(bar && reset).toBe(true);
    if (bar) expect(reset).toBe(true);
    seen.push(extras ? "full" : bar ? "compact" : reset ? "nobar" : "none");
  }
  // The four steps all happen, in this order, as the line narrows.
  const order = ["none", "nobar", "compact", "full"];
  expect(order.every((step) => seen.includes(step))).toBe(true);
  const firsts = order.map((step) => seen.indexOf(step));
  expect([...firsts].sort((x, y) => x - y)).toEqual(firsts);
});

test("a window that already reset is hidden", async ($, on) => {
  world(on);
  withUsage(on, [
    { kind: "five_hour", percentUsed: 80, resetsAt: new Date(NOW - 60_000).toISOString() },
    { kind: "seven_day", percentUsed: 59, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
  ]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { texts } = await band($, "terminal");
  expect(texts).not.toContain("5h");
  expect(texts).toContain("7d");
});

for (const surface of ["terminal", "desktop"] as const) {
  test(`context: the original weather icons in five bands ${surface}`, async ($, on) => {
    world(on);
    on("turn.complete", () => ({ text: "" }));
    // Just under and at each threshold: 25, 50, 75 and 90.
    const fills = [24, 25, 49, 50, 74, 75, 89, 90, 99];
    let call = 0;
    on("session.usage", () => {
      const percent = fills[Math.min(call++, fills.length - 1)];
      return { value: { startedAt: NOW, context: { tokens: percent * 10_000, window: 1_000_000, percent }, rateLimits: LIMITS } };
    });
    await $.session.start({ source: "startup", cwd: "/tmp" } as any);
    // Icon and theme color in the terminal, and the app's drawn-icon color, per band.
    const clear = { icon: "☀", term: "yellow", app: "#e0b000" };
    const cloudy = { icon: "☁", term: "cyan", app: "#8ea3b8" };
    const showers = { icon: "☂", term: "blue", app: "#2f68c0" };
    const storm = { icon: "☇", term: "magenta", app: "#b04fc0" };
    const compact = { icon: "↯", term: "red", app: "#d64545" };
    const expected: [number, typeof clear][] = [[24, clear], [25, cloudy], [49, cloudy], [50, showers], [74, showers], [75, storm], [89, storm], [90, compact], [99, compact]];
    for (const [i, [percent, band_]] of expected.entries()) {
      if (i > 0) await ($ as any).turn.complete({ answer: "ok" } as any);
      const { ui, texts } = await band($, surface);
      expect(texts).toContain(`${percent * 10}k`);
      if (surface === "terminal") {
        const icon: any = await ui.find({ type: "Text", text: band_.icon });
        expect(icon?.props?.color).toBe(band_.term);
      } else {
        const svgs = (await ui.findAll({ type: "Svg" })) as any[];
        const icon = svgs.find((v) => String(v.props?.alt ?? "").endsWith(`${percent}% of 1M`));
        expect(String(icon?.props?.source)).toContain(band_.app);
      }
    }
  });
}

for (const surface of ["terminal", "desktop"] as const) {
  test(`turns after two readings ${surface}`, async ($, on) => {
    world(on);
    on("turn.complete", () => ({ text: "" }));
    // 4 readings: +20k, +80k, +10k tokens.
    const fills = [10, 12, 20, 21];
    let call = 0;
    on("session.usage", () => {
      const percent = fills[Math.min(call++, fills.length - 1)];
      return { value: { startedAt: NOW, context: { tokens: percent * 10_000, window: 1_000_000, percent }, rateLimits: LIMITS } };
    });
    await $.session.start({ source: "startup", cwd: "/tmp" } as any);
    for (let i = 0; i < 3; i++) await ($ as any).turn.complete({ answer: "ok" } as any);
    const { ui, texts } = await band($, surface);
    expect(texts).toContain("210k");
    expect(texts).toContain("▲ +10k");
    if (surface === "terminal") {
      expect(texts).toContain("☀");
      // Earlier prompts in grey (+20k then +80k, the heaviest), current prompt (+10k) in color.
      expect(texts).toContain("▃█");
      const now: any = await ui.find({ type: "Text", text: "▂" });
      expect(now?.props?.color).toBe("yellow");
    } else {
      const svgs = (await ui.findAll({ type: "Svg" })) as any[];
      // Drawn weather icon and turn bars; the limits' bars are characters, as in the terminal. Every drawing carries its alt text.
      const alts = svgs.map((s) => String(s.props?.alt ?? ""));
      expect(alts.every((a) => a.length > 0)).toBe(true);
      expect(alts.filter((a) => a.startsWith("Tokens added") || a.startsWith("Clear")).length).toBe(2);
      // Small icons: gauge, calendar, two reset clocks, cache.
      for (const a of ["5-hour limit", "7-day limit", "Resets in", "Prompt cache"]) expect(alts).toContain(a);
      expect(texts).not.toContain("☀");
    }
  });
}

test("on start, the shared reading wins over an old local one", async ($, on) => {
  // Another session measured 63% two minutes ago.
  world(on, {}, {
    limits: { at: NOW - 120_000, list: [{ kind: "five_hour", percentUsed: 63, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() }] },
  });
  // This idle session still holds an old reading at 34%.
  withUsage(on, [{ kind: "five_hour", percentUsed: 34, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() }]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  // A narrow terminal has no bar, so the percentage is drawn.
  const { texts } = await band($, "terminal", 30);
  expect(texts).toContain("63%");
  expect(texts).not.toContain("34%");
});

test("alert: percentage in red at 90% or more, where there is no bar", async ($, on) => {
  world(on);
  withUsage(on, [{ kind: "five_hour", percentUsed: 95, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() }]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { ui } = await band($, "terminal", 30);
  const value: any = await ui.find({ type: "Text", text: "95%" });
  expect(value?.props?.color).toBe("#ff6b6b");
});

test("narrow terminal: no bar, no detail", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { texts } = await band($, "terminal", 60);
  expect(texts).toContain("32%");
  expect(texts).not.toContain("█");
  expect(texts).not.toContain("· 3h00");
});

test("after a restart, the turn bars come back", async ($, on) => {
  mock.clock(on, { now: NOW });
  mock.env(on, {});
  // In-memory store: this session already had 3 readings (+20k, then +80k); another one has slept for 9 days.
  const store = new Map<string, unknown>([
    ["turns:session-1", { at: NOW - 60_000, readings: [10, 12, 20].map((p) => ({ tokens: p * 10_000, window: 1_000_000, percent: p })) }],
    ["turns:old-session", { at: NOW - 9 * 86_400_000, readings: [] }],
  ]);
  on("store.get", (_$: any, e: any) => ({ value: store.get(e.key) }));
  on("store.set", (_$: any, e: any) => (store.set(e.key, e.value), { value: undefined }));
  on("store.delete", (_$: any, e: any) => (store.delete(e.key), { value: undefined }));
  on("store.keys", () => ({ value: [...store.keys()] }));
  on("session.id", () => ({ value: "session-1" }));
  on("session.start", (_$: any, e: any) => ({ cwd: e.cwd ?? "/tmp" }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.render", ($: any, e: any) => $.ui.resolve(e).Box({ children: [] }));
  // On reopening, the context equals the last reading: no duplicate reading.
  withUsage(on, LIMITS, { tokens: 200_000, window: 1_000_000, percent: 20 });
  await $.session.start({ source: "resume", cwd: "/tmp" } as any);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("▲ +80k");
  // The session idle for more than 8 days is deleted, not this one.
  expect(store.has("turns:old-session")).toBe(false);
  expect(store.has("turns:session-1")).toBe(true);
});

for (const surface of ["terminal", "desktop"] as const) {
  test(`gap with elapsed time hatched ${surface}`, async ($, on) => {
    world(on);
    withUsage(on, [
      // 5 hours: 74% used, window 99% over: margin left.
      { kind: "five_hour", percentUsed: 74, resetsAt: new Date(NOW + 3 * 60_000).toISOString() },
      // 7 days: 80% used for 57% elapsed: ahead of time (alert).
      { kind: "seven_day", percentUsed: 80, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
    ]);
    await $.session.start({ source: "startup", cwd: "/tmp" } as any);
    const { ui } = await band($, surface);
    // The same block bar on both surfaces. 6 cells per bar: 2 grey margin cells (5 h), 2 red cells ahead (7 d).
    const margin = (await ui.findAll({ type: "Text", text: "▒" })) as any[];
    const ahead = (await ui.findAll({ type: "Text", text: "▓" })) as any[];
    expect(margin.filter((d) => d.props?.color === "#4a525c").length).toBe(2);
    expect(ahead.filter((d) => d.props?.color === "#ff6b6b").length).toBe(2);
    // The empty track is a fixed grey, not the theme's dim.
    expect(((await ui.findAll({ type: "Text", text: "░" })) as any[]).some((d) => d.props?.color === "#4a525c")).toBe(true);
    // The solid part is full blocks.
    expect((await ui.findAll({ type: "Text", text: "█" })).length).toBeGreaterThan(0);
  });
}

// ---------- Prompt cache ----------

// One main-loop request answered with this usage.
async function step($: any, usage: Record<string, unknown>, model = "claude-opus-5-5") {
  const stream = $.turn.step({ turnId: "t", index: 0, model, messageCount: 2 });
  for await (const _ of stream) {
  }
  return stream.result;
}

function engineStep(on: any, usages: Record<string, unknown>[]) {
  let call = 0;
  on("turn.step", async function* () {
    const usage = usages[Math.min(call++, usages.length - 1)];
    return { turnId: "t", index: 0, answer: "", toolUses: [], stopReason: "end_turn", usage };
  });
}

const HIT = { model: "claude-opus-5-5", input_tokens: 300, cache_read_input_tokens: 98_000, cache_creation_input_tokens: 1_700, output_tokens: 500 };
const MISS = { model: "claude-opus-5-5", input_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 99_700, output_tokens: 500 };

// The cache pill's hover card in the app; null without one.
async function boltTip(ui: any): Promise<string | null> {
  return cardOf(ui, "cache");
}

test("cache: share read and time left on a subscription (1 hour)", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  engineStep(on, [HIT]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, HIT);
  const { ui, texts } = await band($, "terminal");
  expect(texts).toContain("cache");
  // 98% served: the time left alone (1 hour, counted from the request's start).
  expect(texts).not.toContain("98%");
  expect(texts).toContain("1h00");
  const time: any = await ui.find({ type: "Text", text: "1h00" });
  expect(time?.props?.bold).toBe(true);
  expect(time?.props?.color).toBeUndefined();
});

test("cache: yellow under 10 minutes, then expired with /compact", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  mock.store(on, {});
  mock.env(on, {});
  on("session.id", () => ({ value: "session-1" }));
  on("session.start", (_$: any, e: any) => ({ cwd: e.cwd ?? "/tmp" }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.render", ($: any, e: any) => $.ui.resolve(e).Box({ children: [] }));
  withUsage(on, LIMITS);
  engineStep(on, [HIT]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, HIT);
  await (clock as any).advance(55 * 60_000);
  let { ui, texts } = await band($, "terminal");
  expect(texts).toContain("5 min");
  const soon: any = await ui.find({ type: "Text", text: "5 min" });
  expect(soon?.props?.color).toBe("#a8690a");
  // Under 10 minutes: signaled by color alone, no warning mark.
  expect(soon?.props?.bold).toBe(true);
  expect(texts).not.toContain("⚠");
  // What letting it lapse writes again: the 107k context, dim.
  const stake: any = await ui.find({ type: "Text", text: "· 107k at stake" });
  expect(stake?.props?.dimColor).toBe(true);
  const desktop = await band($, "desktop");
  expect(desktop.texts).toContain("107k at stake");
  const yellow: any = await desktop.ui.find({ type: "Text", text: "5 min" });
  expect(yellow?.props?.color).toBe("#a8690a");
  expect(await boltTip(desktop.ui)).toBe(
    `The cache expires at ${at(NOW + 3_600_000)}. Send your next message before then, or it writes 107k tokens again.`,
  );
  await (clock as any).advance(6 * 60_000);
  ({ ui, texts } = await band($, "terminal"));
  expect(texts).toContain("expired");
  // 107k of context: past 100k, what gets written again, and /compact before going on.
  expect(texts).toContain("· 107k to rewrite · /compact");
  const expired: any = await ui.find({ type: "Text", text: "expired" });
  expect(expired?.props?.color).toBe("#ff6b6b");
  expect(expired?.props?.bold).toBe(true);
  // Expired: red and bold, no warning mark.
  expect(texts).not.toContain("⚠");
});

test("cache: a miss after a model change names the cause", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  engineStep(on, [HIT, { ...MISS, model: "claude-sonnet-5-5" }]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, HIT);
  await step($, MISS, "claude-sonnet-5-5");
  const { texts } = await band($, "terminal");
  expect(texts).toContain("0%");
  expect(texts).toContain("· missed · model changed");
  const desktop = await band($, "desktop");
  expect(desktop.texts).toContain("missed · model changed");
  expect(await boltTip(desktop.ui)).toBe("This message read only 0% from the cache (model changed): it wrote 99.7k tokens again.");
});

test("cache: 5 minutes on an API key (no plan window)", async ($, on) => {
  world(on);
  withUsage(on, []);
  engineStep(on, [HIT]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, HIT);
  const { ui, texts } = await band($, "terminal");
  expect(texts).toContain("5 min");
  // The lifetime is in sight, and a fresh 5-minute cache is not yellow (the threshold follows the lifetime).
  expect(texts.join(" ")).toContain("5 min TTL · x1.25");
  const time: any = await ui.find({ type: "Text", text: "5 min" });
  expect(time?.props?.color).toBeUndefined();
});

test("cache: 5 minutes shows x1.25, and expired keeps the same format", async ($, on) => {
  const clock = world(on);
  withUsage(on, []);
  engineStep(on, [HIT]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, HIT);
  await clock.advance(6 * 60_000);
  const { ui, texts } = await band($, "terminal");
  expect(texts).toContain("expired");
  // Expired: the lifetime and the write multiplier stay beside it, before the advice.
  expect(texts).toContain("· 107k to rewrite · 5 min TTL · x1.25 · /compact");
  expect(((await ui.find({ type: "Text", text: "expired" })) as any)?.props?.color).toBe("#ff6b6b");
});

test("cache: the yellow threshold is a sixth of the lifetime (50 s of 5 minutes)", async ($, on) => {
  const clock = world(on);
  withUsage(on, []);
  engineStep(on, [HIT]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, HIT);
  await clock.advance(4 * 60_000);
  let { ui, texts } = await band($, "terminal");
  expect(texts).toContain("1 min");
  expect(((await ui.find({ type: "Text", text: "1 min" })) as any)?.props?.color).toBeUndefined();
  await clock.advance(20_000);
  ({ ui, texts } = await band($, "terminal"));
  // 40 s left: under 50 s.
  expect(texts).toContain("< 1 min");
  expect(((await ui.find({ type: "Text", text: "< 1 min" })) as any)?.props?.color).toBe("#a8690a");
});

test("agents: a pill while subagents run, gone once they finish", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  let list = [
    { id: "a1", description: "Review the diff", type: "Plan", status: "running" },
    { id: "a2", description: "Search the repo", type: "Explore", status: "running" },
    { id: "a0", description: "Earlier", type: "Explore", status: "completed" },
  ];
  on("agent.list", () => ({ value: list }));
  on("turn.complete", () => ({ text: "" }));
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const desktop = await band($, "desktop");
  expect(desktop.texts).toContain("2 agents");
  expect(String(await cardOf(desktop.ui, "agents"))).toContain("Plan · Review the diff");
  list = list.map((a) => ({ ...a, status: "completed" }));
  await ($ as any).turn.complete({ answer: "ok", agentId: "a1" } as any);
  const after = await band($, "terminal");
  expect(after.texts.some((t: string) => t.includes("agent"))).toBe(false);
});

test("desktop icons: gauge centred at y=12", async ($, on) => {
  world(on);
  withUsage(on, LIMITS, { tokens: 400_000, window: 1_000_000, percent: 40 });
  await $.session.start({ source: "resume", cwd: "/tmp" } as any);
  const { ui } = await band($, "desktop");
  const svgs = (await ui.findAll({ type: "Svg" })) as any[];
  const source = (alt: string) => String(svgs.find((s) => s.props?.alt === alt)?.props?.source);
  expect(source("5-hour limit")).toContain('<g transform="translate(0 0.5)"><path d="M3.6 18.5');
});

test("cache expired from 300k: what gets written again, and a new thread", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  mock.store(on, {});
  mock.env(on, {});
  on("session.id", () => ({ value: "session-1" }));
  on("session.start", (_$: any, e: any) => ({ cwd: e.cwd ?? "/tmp" }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.render", ($: any, e: any) => $.ui.resolve(e).Box({ children: [] }));
  withUsage(on, LIMITS, { tokens: 741_000, window: 1_000_000, percent: 74 });
  engineStep(on, [HIT]);
  await $.session.start({ source: "resume", cwd: "/tmp" } as any);
  await step($, HIT);
  await (clock as any).advance(61 * 60_000);
  const { texts } = await band($, "terminal");
  // A new thread avoids rewriting the whole context; a compaction would read it all again.
  // The terminal has no tooltip: the advice stays on the line.
  expect(texts).toContain("· 741k to rewrite · new thread");
  expect(texts.join(" ")).not.toContain("/compact");
  // In the app the advice moves to the bolt's tooltip.
  const desktop = await band($, "desktop");
  expect(desktop.texts).toContain("741k to rewrite");
  expect(desktop.texts.join(" ")).not.toContain("new thread");
  const tip = String(await boltTip(desktop.ui));
  expect(tip).toContain("The next message writes the whole context (741k) again at full price.");
  expect(tip).toContain("A new thread avoids this rewrite; a compaction would read it all again.");
  expect(tip).not.toContain("/compact");
});

test("cache: below 90% served, the share before the time", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const PART = { ...HIT, cache_read_input_tokens: 72_000, cache_creation_input_tokens: 0, input_tokens: 28_000 };
  engineStep(on, [PART]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, PART);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("72%");
  // After the time, dim.
  expect(texts).toContain("· 1h00");
});

test("desktop: pills never shrink, and the 5-hour reset time sits in the pill's hover card", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { ui } = await band($, "desktop");
  const pills = ((await ui.findAll({ type: "Box" })) as any[]).filter((b) => b.props?.backgroundColor && b.props?.position !== "absolute");
  for (const p of pills) expect(p.props?.flexShrink).toBe(0);
  expect(await cardOf(ui, "gauge-5h")).toBe(`Resets at ${at(NOW + 3 * 3_600_000)}`);
});

// ---------- Compaction ----------

// A large thread whose cache expired, as the band showed it before a /compact.
async function largeExpired($: any, on: any, compaction: Record<string, unknown>) {
  const clock = mock.clock(on, { now: NOW });
  mock.store(on, {});
  mock.env(on, {});
  on("session.id", () => ({ value: "session-1" }));
  on("session.start", (_$: any, e: any) => ({ cwd: e.cwd ?? "/tmp" }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.render", ($: any, e: any) => $.ui.resolve(e).Box({ children: [] }));
  on("turn.complete", () => ({ text: "" }));
  on("session.compact", () => compaction);
  withUsage(on, LIMITS, { tokens: 784_000, window: 1_000_000, percent: 78 });
  engineStep(on, [
    { ...HIT, cache_read_input_tokens: 780_000 },
    // The first request after the compaction writes the whole, smaller, context.
    { ...MISS, cache_creation_input_tokens: 47_700 },
  ]);
  await $.session.start({ source: "resume", cwd: "/tmp" } as any);
  await step($, HIT);
  await (clock as any).advance(75 * 60_000);
  return clock;
}

test("compaction: the context drops at once, no expired cache", async ($, on) => {
  await largeExpired($, on, { messages: [{ role: "user", text: "Summary of the thread", toolUses: [] }], tokensBefore: 784_000, tokensAfter: 48_000 });
  const before = await band($, "terminal");
  expect(before.texts).toContain("784k");
  expect(before.texts).toContain("expired");
  expect(before.texts).toContain("· 784k to rewrite · new thread");
  await ($ as any).session.compact({ trigger: "manual", messages: [{ role: "user", text: "Go on", toolUses: [] }, { role: "assistant", text: "Done", toolUses: [] }] });
  const after = await band($, "terminal");
  expect(after.texts).toContain("48k");
  expect(after.texts).not.toContain("784k");
  expect(after.texts.join(" ")).not.toContain("new thread");
  expect(after.texts).not.toContain("expired");
  expect(after.texts).toContain("compacted");
  expect(await boltTip((await band($, "desktop")).ui)).toBe("Compacted: the next message writes a new, smaller cache.");
  // The next request writes a new cache: neither a miss nor expired.
  await step($, HIT);
  const next = await band($, "terminal");
  expect(next.texts).not.toContain("compacted");
  expect(next.texts.join(" ")).not.toContain("missed");
  expect(next.texts).toContain("1h00");
});

test("compaction: a skipped one changes nothing", async ($, on) => {
  await largeExpired($, on, { skip: "blocked by a hook" });
  await ($ as any).session.compact({ trigger: "manual", messages: [{ role: "user", text: "Go on", toolUses: [] }, { role: "assistant", text: "Done", toolUses: [] }] });
  const { texts } = await band($, "terminal");
  expect(texts).toContain("784k");
  expect(texts).toContain("expired");
  expect(texts).not.toContain("compacted");
});

// ---------- Cache tooltip ----------

// A large thread: 289k of context, 287k of it read from the cache by the last message.
const BIG = { tokens: 289_000, window: 1_000_000, percent: 29 };
const BIG_HIT = { model: "claude-opus-5-5", input_tokens: 300, cache_read_input_tokens: 287_000, cache_creation_input_tokens: 1_700, output_tokens: 500 };

test("cache tooltip, warm, English: lifetime assumed", async ($, on) => {
  world(on);
  withUsage(on, LIMITS, BIG);
  engineStep(on, [BIG_HIT]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, BIG_HIT);
  await step($, BIG_HIT);
  expect(await boltTip((await band($, "desktop")).ui)).toBe(
    [
      `Cache warm until ${at(NOW + 3_600_000)} (1-hour lifetime, assumed).`,
      "Last message: 99% read from the cache (287k).",
    ].join("\n"),
  );
});

test("cache: under 10 minutes and under 90% served, the stake after the time", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  const PART = { ...HIT, cache_read_input_tokens: 72_000, cache_creation_input_tokens: 0, input_tokens: 28_000 };
  engineStep(on, [PART]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, PART);
  await clock.advance(55 * 60_000);
  const { ui, texts } = await band($, "terminal");
  expect(texts).toContain("72%");
  const time: any = await ui.find({ type: "Text", text: "· 5 min" });
  expect(time?.props?.color).toBe("#a8690a");
  // The share carries the same color, bold: the whole cache value signals by color.
  const share: any = await ui.find({ type: "Text", text: "72%" });
  expect(share?.props?.color).toBe("#a8690a");
  expect(share?.props?.bold).toBe(true);
  expect(texts).toContain("· 107k at stake");
  expect(texts.indexOf("· 5 min")).toBeLessThan(texts.indexOf("· 107k at stake"));
});

test("cache expired at 150k: the size in the pill, /compact in the tooltip", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS, { tokens: 150_000, window: 1_000_000, percent: 15 });
  engineStep(on, [HIT]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, HIT);
  await clock.advance(61 * 60_000);
  const desktop = await band($, "desktop");
  expect(desktop.texts).toContain("150k to rewrite");
  expect(desktop.texts.join(" ")).not.toContain("/compact");
  expect(await boltTip(desktop.ui)).toBe(
    "The next message writes the whole context (150k) again at full price.\n/compact before going on: the context written again will be smaller.",
  );
  // The terminal, without a tooltip, keeps the advice on the line.
  const { texts } = await band($, "terminal");
  expect(texts).toContain("· 150k to rewrite · /compact");
});

test("cache: speaks in tokens, never dollars", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  engineStep(on, [HIT]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, HIT);
  let desktop = await band($, "desktop");
  // Warm: no lifetime label on 1 hour, no price.
  expect(desktop.texts.join(" ")).not.toContain("TTL");
  expect(desktop.texts.join(" ")).not.toContain("$");
  expect(desktop.texts.join(" ")).not.toContain("if it lapses");
  await clock.advance(55 * 60_000);
  desktop = await band($, "desktop");
  expect(desktop.texts).toContain("107k at stake");
  expect(desktop.texts.join(" ")).not.toContain("$");
  expect(String(await boltTip(desktop.ui))).not.toContain("$");
  await clock.advance(6 * 60_000);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("· 107k to rewrite · /compact");
  expect(texts.join(" ")).not.toContain("$");
});

// ---------- Next steps: the suggestions after a turn ----------

const COMMANDS = [
  { name: "review-pr", description: "Review a pull request", source: "plugin" },
  { name: "clear", description: "Clear the conversation", source: "builtin" },
];
const ITEMS = [
  { label: "Run the tests", prompt: "run the tests you just wrote" },
  { label: "Commit", prompt: "commit the change" },
  { label: "Open the PR", prompt: "open a pull request" },
];
const ANSWER = "x".repeat(200);

// The detached fork finishes some ticks after the turn does.
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

// What the fork answers; fork prompts and ghost texts are recorded.
function suggesting(on: any, reply: unknown, options: { commands?: unknown[]; fork?: () => Promise<unknown> } = {}) {
  const seen = { forks: [] as string[], ghosts: [] as string[] };
  on("command.list", () => ({ value: options.commands ?? COMMANDS }));
  on("ui.log", () => ({ value: undefined }));
  on("model.fork", async (_$: any, e: any) => {
    seen.forks.push(e.prompt);
    if (options.fork) return { value: await options.fork() };
    return { value: { isAnswered: true, text: typeof reply === "string" ? reply : JSON.stringify(reply), usage: {} } };
  });
  on("prompt.suggest", (_$: any, e: any) => {
    seen.ghosts.push(e.text);
    return { isShown: true };
  });
  on("turn.complete", () => ({ text: "" }));
  on("turn.start", (_$: any, e: any) => ({ turnId: e.turnId }));
  return seen;
}

async function turnDone($: any, extra: Record<string, unknown> = {}) {
  await ($ as any).turn.complete({ reason: "answer", answer: ANSWER, turnId: "t1", durationMs: 1, isAborted: false, ...extra } as any);
  await settle();
}

test("suggestions: a long answer forks and offers the first prompt as ghost text", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.forks.length).toBe(1);
  expect(seen.ghosts).toEqual(["run the tests you just wrote"]);
});

test("suggestions: an answer under minAnswerChars makes no fork", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($, { answer: "x".repeat(20) });
  expect(seen.forks.length).toBe(0);
});

test("suggestions: minAnswerChars is a setting", { options: { minAnswerChars: 10 } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($, { answer: "x".repeat(20) });
  expect(seen.forks.length).toBe(1);
});

test("suggestions: a subagent's turn makes no fork", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($, { agentId: "a1" });
  expect(seen.forks.length).toBe(0);
});

test("suggestions: the fork is told the session's skills", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.forks[0]).toContain("/review-pr: Review a pull request");
  expect(seen.forks[0]).not.toContain("/clear");
});

test("suggestions: without suggestSkills the fork gets no skill list", { options: { suggestSkills: false } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.forks[0]).not.toContain("<available-skills>");
});

test("suggestions: a slash prompt naming an unknown command is dropped", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, [
    { label: "Made up", prompt: "/made-up now" },
    { label: "Review", prompt: "/review-pr 12" },
  ]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.ghosts).toEqual(["/review-pr 12"]);
});

test("suggestions: unsafe text is cleaned, and a tag character drops the suggestion", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, [
    { label: "Hidden", prompt: `fix it\u{E0041}\u{E0042}` },
    { label: "Clean\u001b[31m me", prompt: "run \u001b[31mthe\u0007 tests\n  now" },
  ]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.ghosts).toEqual(["run the tests now"]);
});

test("suggestions: prose, bad JSON, an unanswered or a failing fork offer nothing", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, "I would suggest running the tests.");
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.forks.length).toBe(1);
  expect(seen.ghosts).toEqual([]);
});

test("suggestions: a fork that throws offers nothing and does not break the turn", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS, { fork: () => Promise.reject(new Error("boom")) });
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.ghosts).toEqual([]);
});

test("suggestions: a result that arrives after a newer turn is dropped", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  let release: (v: unknown) => void = () => {};
  const held = new Promise((r) => (release = r));
  let call = 0;
  const seen = suggesting(on, ITEMS, {
    fork: () => (call++ === 0 ? held : Promise.resolve({ isAnswered: true, text: JSON.stringify([{ label: "Second", prompt: "second prompt" }]), usage: {} })),
  });
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($, { turnId: "t1" });
  await turnDone($, { turnId: "t2" });
  release({ isAnswered: true, text: JSON.stringify(ITEMS), usage: {} });
  await settle();
  expect(seen.ghosts).toEqual(["second prompt"]);
});

// The labels of the buttons a mounted band draws, in order.
async function labels(ui: any): Promise<string[]> {
  return ((await ui.findAll({ type: "Button" })) as any[]).map((b) => String(b.props?.label ?? ""));
}

async function offered($: any, on: any, extra: { below?: string; usage?: boolean } = {}) {
  world(on, {}, {}, extra.below);
  if (extra.usage !== false) withUsage(on, LIMITS);
  else withUsage(on, [], { tokens: 0, window: 0, percent: 0 });
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  return seen;
}

test("suggestions: the offer lists the labels, then dismiss, and the usage line comes last", async ($, on) => {
  await offered($, on);
  const { ui, texts } = await band($, "terminal");
  expect(texts).toContain("next:");
  expect(await labels(ui)).toEqual(["Run the tests", "Commit", "Open the PR", "dismiss"]);
  expect(texts.indexOf("next:")).toBeLessThan(texts.indexOf("107k"));
});

test("suggestions: a blank line separates the offer from the usage line", async ($, on) => {
  await offered($, on);
  const { ui } = await band($, "terminal");
  const gaps = ((await ui.findAll({ type: "Box" })) as any[]).filter((b) => b.key === "gap-usage");
  expect(gaps.length).toBe(1);
  expect(gaps[0].props?.marginTop).toBe(1);
});

test("suggestions: no extra blank line without the offer", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { ui } = await band($, "terminal");
  expect(((await ui.findAll({ type: "Box" })) as any[]).some((b) => b.key === "gap-usage")).toBe(false);
});

test("suggestions: draw without any usage reading", async ($, on) => {
  await offered($, on, { usage: false });
  const { ui, texts } = await band($, "terminal");
  expect(texts).toContain("next:");
  expect(await labels(ui)).toContain("Commit");
});

test("suggestions: hidden while the model works, the line still draws", async ($, on) => {
  await offered($, on);
  const ui: any = await $.ui.mount({ plugin: "hud", surface: "terminal", component: "AbovePrompt", props: { bodyColumns: 200, isWorking: true } as any });
  const texts = ((await ui.findAll({ type: "Text" })) as any[]).map((t) => t.text);
  expect(texts).not.toContain("next:");
  expect(texts).toContain("107k");
});

test("suggestions: nothing from this mod during a survey", async ($, on) => {
  await offered($, on);
  const ui: any = await $.ui.mount({ plugin: "hud", surface: "terminal", component: "AbovePrompt", props: { bodyColumns: 200, hasSurvey: true } as any });
  const texts = ((await ui.findAll({ type: "Text" })) as any[]).map((t) => t.text);
  expect(texts).not.toContain("next:");
  expect(texts).not.toContain("107k");
});

test("suggestions: a wait line while the fork runs", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  suggesting(on, ITEMS, { fork: () => new Promise(() => {}) });
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("next steps…");
  expect(texts).not.toContain("next:");
});

test("suggestions: the next turn hides the block; a subagent's start does not", async ($, on) => {
  await offered($, on);
  await ($ as any).turn.start({ text: "go", turnId: "t2", agentId: "a1" } as any);
  expect((await band($, "terminal")).texts).toContain("next:");
  await ($ as any).turn.start({ text: "go", turnId: "t3" } as any);
  expect((await band($, "terminal")).texts).not.toContain("next:");
});

test("suggestions: pressing dismiss hides the block", async ($, on) => {
  await offered($, on);
  const { ui } = await band($, "terminal");
  await ui.press({ key: "dismiss" } as any);
  expect((await band($, "terminal")).texts).not.toContain("next:");
});

test("suggestions: the desktop draws no block, only the line", async ($, on) => {
  await offered($, on);
  const { texts } = await band($, "desktop");
  expect(texts).not.toContain("next:");
  expect(texts).toContain("107k");
});

// ---------- Next steps: picking several into one draft ----------

// An offer with prompt.fill answering as told; the filled texts and the toasts are recorded.
async function picking($: any, on: any, fill: "filled" | "refused" | "rejects" = "filled", items: unknown[] = ITEMS) {
  const filled: string[] = [];
  const toasts: string[] = [];
  on("prompt.fill", (_$: any, e: any) => {
    if (fill === "rejects") throw new Error("boom");
    filled.push(e.text);
    return { isFilled: fill === "filled" };
  });
  on("ui.toast", (_$: any, e: any) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  world(on);
  withUsage(on, LIMITS);
  suggesting(on, items);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  return { filled, toasts };
}

async function press($: any, ...keys: string[]) {
  for (const key of keys) await (await band($, "terminal")).ui.press({ key } as any);
  return labels((await band($, "terminal")).ui);
}

test("picking: marks follow the order of choice, and write shows how many", async ($, on) => {
  await picking($, on);
  expect(await press($, "pick-1", "pick-3")).toEqual(["[1] Run the tests", "Commit", "[2] Open the PR", "write 2 to prompt", "dismiss"]);
  expect(await press($, "pick-3")).toEqual(["[1] Run the tests", "Commit", "Open the PR", "write 1 to prompt", "dismiss"]);
  expect(await press($, "pick-1")).toEqual(["Run the tests", "Commit", "Open the PR", "dismiss"]);
});

test("picking: choosing 3 before 1 keeps that order in the draft", async ($, on) => {
  const { filled } = await picking($, on);
  expect(await press($, "pick-3", "pick-1")).toEqual(["[2] Run the tests", "Commit", "[1] Open the PR", "write 2 to prompt", "dismiss"]);
  await press($, "write");
  expect(filled).toEqual(["Do these in order, one after the other:\n1. open a pull request\n2. run the tests you just wrote"]);
});

test("picking: one pick fills the prompt as it is", async ($, on) => {
  const { filled } = await picking($, on);
  await press($, "pick-2", "write");
  expect(filled).toEqual(["commit the change"]);
});

test("picking: writing hides the block", async ($, on) => {
  await picking($, on);
  await press($, "pick-1", "write");
  expect((await band($, "terminal")).texts).not.toContain("next:");
});

test("picking: a new offer starts with no picks", async ($, on) => {
  await picking($, on);
  await press($, "pick-1");
  await turnDone($, { turnId: "t2" });
  expect(await labels((await band($, "terminal")).ui)).toEqual(["Run the tests", "Commit", "Open the PR", "dismiss"]);
});

test("picking: a fill that is not accepted shows a toast", async ($, on) => {
  const { toasts } = await picking($, on, "refused");
  await press($, "pick-1", "write");
  expect(toasts).toEqual(["could not fill the prompt box"]);
});

test("picking: a fill that rejects shows a toast", async ($, on) => {
  const { toasts } = await picking($, on, "rejects");
  await press($, "pick-1", "write");
  expect(toasts.length).toBe(1);
  expect(toasts[0]).toContain("could not fill:");
});

test("picking: a slash suggestion alone is filled as it is, inside a combination it is plain text", async ($, on) => {
  const { filled } = await picking($, on, "filled", [
    { label: "Review", prompt: "/review-pr 12" },
    { label: "Commit", prompt: "commit the change" },
  ]);
  await press($, "pick-1", "write");
  expect(filled[0]).toBe("/review-pr 12");
  await turnDone($, { turnId: "t2" });
  await press($, "pick-1", "pick-2", "write");
  expect(filled[1]).toBe("Do these in order, one after the other:\n1. /review-pr 12\n2. commit the change");
});

// ---------- Next steps: the deferred review minors ----------

test("suggestions: invalid JSON offers nothing", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, '[{"label": "Run", "prompt": "run the tests"');
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.forks.length).toBe(1);
  expect(seen.ghosts).toEqual([]);
  expect((await band($, "terminal")).texts).not.toContain("next:");
});

test("suggestions: a fork that is not answered offers nothing", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS, { fork: async () => ({ isAnswered: false, reason: "api-error" }) });
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.forks.length).toBe(1);
  expect(seen.ghosts).toEqual([]);
  expect((await band($, "terminal")).texts).not.toContain("next:");
});

test("picking: a press from an older, longer offer picks nothing", async ($, on) => {
  const filled: string[] = [];
  on("prompt.fill", (_$: any, e: any) => {
    filled.push(e.text);
    return { isFilled: true };
  });
  world(on);
  withUsage(on, LIMITS);
  let call = 0;
  // The first offer has three items, the second only one.
  suggesting(on, null, { fork: async () => ({ isAnswered: true, text: JSON.stringify(call++ === 0 ? ITEMS : [ITEMS[0]]), usage: {} }) });
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  const old = (await band($, "terminal")).ui;
  await turnDone($, { turnId: "t2" });
  await old.press({ key: "pick-3" } as any).catch(() => undefined);
  expect(await labels((await band($, "terminal")).ui)).toEqual(["Run the tests", "dismiss"]);
  expect(filled).toEqual([]);
});

// ---------- Info line: model, effort, speed, folder, branch ----------

// A fake git by subcommand; `repo: false` answers every one as outside a repository, and `dirty`
// puts that many changed files and a diff of 70 added and 4 removed lines in the working tree.
function hostInfo(on: any, { branch = "andersonsilva/feat", model = "claude-sonnet-5-5" as string | (() => string), repo = true, dirty = 0 } = {}) {
  on("session.cwd", () => ({ value: "/work/spider-marketplace" }));
  on("session.model", () => ({ value: typeof model === "function" ? model() : model }));
  on("process.run", (_$: any, e: any) => {
    const out = (exitCode: number, stdout = "") => ({ value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } });
    if (!repo) return out(128);
    if (e.argv.includes("branch")) return out(0, branch + "\n");
    if (e.argv.includes("status")) return out(0, Array.from({ length: dirty }, (_, i) => ` M file${i}.ts\n`).join(""));
    if (e.argv.includes("diff")) return out(0, "60\t3\tplugins/hud/hooks/hud.mjs\n10\t1\tplugins/hud/tests/hud.test.ts\n-\t-\timage.png\n");
    return out(1);
  });
}

// A main-loop request that takes `ms` and writes `tokens`.
function slowStep(on: any, clock: any, ms: number, tokens: number) {
  on("turn.step", async function* () {
    await clock.advance(ms);
    return { turnId: "t", index: 0, answer: "", toolUses: [], stopReason: "end_turn", usage: { model: "claude-sonnet-5-5", input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: tokens } };
  });
}

test("info: the model, folder and branch show above the usage line before any request", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("claude-sonnet-5-5".replace("claude-", "").replace(/^s/, "S").replace("-5-5", " 5.5"));
  expect(texts).toContain("spider-marketplace");
  expect(texts).toContain("andersonsilva/feat");
  expect(texts.indexOf("spider-marketplace")).toBeLessThan(texts.indexOf("107k"));
});

test("info: effort and speed come from the last request", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  slowStep(on, clock, 5000, 360);
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  const stream = $.turn.step({ turnId: "t", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 2 } as any);
  for await (const _ of stream) {
  }
  const { texts } = await band($, "terminal");
  expect(texts).toContain("Opus 5.5");
  expect(texts).toContain("high");
  expect(texts).toContain("72 tok/s");
});

test("info: a /model switch shows within the 10 s tick, and the old effort goes", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  let model = "claude-sonnet-5-5";
  hostInfo(on, { model: () => model });
  slowStep(on, clock, 5000, 360);
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  const stream = $.turn.step({ turnId: "t", index: 0, model: "claude-sonnet-5-5", effort: "high", messageCount: 2 } as any);
  for await (const _ of stream) {
  }
  expect((await band($, "terminal")).texts).toContain("high");
  // Same model: the request's own id and effort stay.
  await clock.advance(10_000);
  expect((await band($, "terminal")).texts).toContain("high");
  model = "claude-opus-5-5";
  await clock.advance(10_000);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("Opus 5.5");
  expect(texts).not.toContain("Sonnet 5.5");
  expect(texts).not.toContain("high");
});

test("info: a request too short to measure leaves no speed", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  slowStep(on, clock, 100, 360);
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  const stream = $.turn.step({ turnId: "t", index: 0, model: "claude-sonnet-5-5", messageCount: 2 } as any);
  for await (const _ of stream) {
  }
  const { texts } = await band($, "terminal");
  expect(texts.some((t) => t.endsWith("tok/s"))).toBe(false);
});

test("info: outside a git repository the branch is left out", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on, { repo: false });
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("spider-marketplace");
  expect(texts).not.toContain("andersonsilva/feat");
});

test("info: on a narrow terminal the speed, effort and folder go first and the branch stays", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  slowStep(on, clock, 5000, 360);
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  const stream = $.turn.step({ turnId: "t", index: 0, model: "claude-sonnet-5-5", effort: "high", messageCount: 2 } as any);
  for await (const _ of stream) {
  }
  const { texts } = await band($, "terminal", 40);
  expect(texts).toContain("Sonnet 5.5");
  expect(texts).toContain("andersonsilva/feat");
  expect(texts).not.toContain("72 tok/s");
  expect(texts).not.toContain("spider-marketplace");
});

test("info: the desktop draws no info line", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  const { texts } = await band($, "desktop");
  expect(texts).not.toContain("andersonsilva/feat");
});

test("info: the changed files and lines hang on the branch", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on, { dirty: 1 });
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("· 1 file");
  expect(texts).toContain("+70");
  expect(texts).toContain("-4");
});

test("info: a branch with changes is red with a star, a clean one green", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on, { dirty: 1 });
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  const dirty: any = await (await band($, "terminal")).ui.find({ type: "Text", text: "andersonsilva/feat*" });
  expect(dirty.props?.color).toBe("#ff6b6b");
});

test("info: a clean branch is green and has no star", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  const clean: any = await (await band($, "terminal")).ui.find({ type: "Text", text: "andersonsilva/feat" });
  expect(clean.props?.color).toBe("#6fcf97");
});

test("info: several changed files are counted in the plural", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on, { dirty: 3 });
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  expect((await band($, "terminal")).texts).toContain("· 3 files");
});

test("info: a clean tree shows no changes", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  expect((await band($, "terminal")).texts.some((t) => /^· \d+ files?$/.test(t))).toBe(false);
});
