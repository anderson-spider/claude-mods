import { test, expect, mock } from "claude-code/testing";
import { NOW, at, LIMITS, world, withUsage, band, cardOf, cardNodes, step, engineStep, HIT } from "./helpers";

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
    // The bar (a drawn rail in the app) and the percentage beside it.
    if (surface === "terminal") expect(texts).toContain("━");
    else expect(((await ui.findAll({ type: "Svg" })) as any[]).some((s) => s.props?.alt === "32% used, 40% of the window gone")).toBe(true);
    expect(texts).toContain("32%");
    const dot = surface === "terminal" ? "· " : "";
    // The time left alone; the reset time is in the clock's tooltip.
    expect(texts).toContain(`${dot}3h`);
    expect(texts).not.toContain(`${dot}3h → ${at(NOW + 3 * 3_600_000)}`);
    expect(texts).toContain("59%");
    expect(texts).toContain(`${dot}3d`);
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
      // The same order as the terminal: context and cache, then the limits.
      expect(texts.indexOf("—")).toBeLessThan(texts.indexOf("5h"));
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

for (const surface of ["terminal", "desktop"] as const) {
  test(`pace mark: ▲ ahead in amber, ▼ behind in green, with the gap in points ${surface}`, async ($, on) => {
    world(on);
    withUsage(on, LIMITS);
    await $.session.start({ source: "startup", cwd: "/tmp" } as any);
    const { ui, texts } = await band($, surface);
    // 7 days: 59% used against 57% of the time elapsed, 2 points ahead. 5 hours: 32% against 40%, 8 behind.
    expect(texts).toContain("▲2");
    expect(texts).toContain("▼8");
    // The 5-hour window comes first: its mark sits between "5h" and "7d", the 7-day mark after "7d".
    expect(texts.indexOf("5h")).toBeLessThan(texts.indexOf("▼8"));
    expect(texts.indexOf("▼8")).toBeLessThan(texts.indexOf("7d"));
    expect(texts.indexOf("7d")).toBeLessThan(texts.indexOf("▲2"));
    const ahead: any = await ui.find({ type: "Text", text: "▲2" });
    expect(ahead?.props?.bold).toBe(true);
    expect(ahead?.props?.color).toBe("#a8690a");
    const behind: any = await ui.find({ type: "Text", text: "▼8" });
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
  expect(texts).toContain("▲33");
  expect(texts).toContain("▼30");
  const ahead: any = await ui.find({ type: "Text", text: "▲33" });
  expect(ahead?.props?.color).toBe("#ff6b6b");
  const behind: any = await ui.find({ type: "Text", text: "▼30" });
  expect(behind?.props?.color).toBe("#6fcf97");
});

test("pace mark: none for a window without a length", async ($, on) => {
  world(on);
  withUsage(on, [{ kind: "spend_limit", percentUsed: 40 }]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("$");
  expect(texts).toContain("━");
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
  expect(texts).toContain("▼8");
});

test("pace start: a lead beyond the start is flagged", { options: { paceStart: 1 } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("▲2");
});

test("narrow terminal: the cache gives up its extras, and the limits their bars, then the times left", async ($, on) => {
  // The 5-minute lifetime is the one with extras (its label) to give up.
  world(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" });
  withUsage(on, LIMITS);
  engineStep(on, [HIT]);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await step($, HIT);
  const limits: string[] = [];
  const extras: boolean[] = [];
  for (let columns = 20; columns <= 200; columns += 2) {
    const { texts } = await band($, "terminal", columns);
    const bar = texts.includes("━");
    const reset = texts.includes("· 3h") && texts.includes("· 3d");
    // On the limits row the bar only ever shows with the times left.
    if (bar) expect(reset).toBe(true);
    limits.push(bar ? "full" : reset ? "nobar" : "none");
    extras.push(texts.some((t) => t.includes("TTL")));
  }
  // Each row's steps all happen, in order, as the terminal widens.
  const order = ["none", "nobar", "full"];
  const firsts = order.map((step) => limits.indexOf(step));
  expect(firsts.every((i) => i >= 0)).toBe(true);
  expect([...firsts].sort((x, y) => x - y)).toEqual(firsts);
  expect(extras[0]).toBe(false);
  expect(extras[extras.length - 1]).toBe(true);
  expect(extras.slice(extras.indexOf(true)).every(Boolean)).toBe(true);
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
  // The context has a row of its own: only the limits and the cache have to fit.
  const { texts } = await band($, "terminal", 30);
  expect(texts).toContain("32%");
  expect(texts).not.toContain("━");
  expect(texts).not.toContain("· 3h");
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

// The cells of the quota bars, in order, as one string per bar ("━━╌╌╌╌╌╌╌│─").
async function bars(ui: any): Promise<string[]> {
  const boxes = ((await ui.findAll({ type: "Box" })) as any[]).filter((b) => b.props?.key === "bar");
  return boxes.map((b) => ((b.children ?? []) as any[]).map((c) => String(c.children ?? c.props?.children ?? "")).join(""));
}

// The SVG sources of the app's rails, in order.
async function rails(ui: any): Promise<string[]> {
  return ((await ui.findAll({ type: "Svg" })) as any[]).filter((s) => / used\b/.test(String(s.props?.alt))).map((s) => String(s.props.source));
}

const PACED = [
  // 5 hours: 22% used, 87% of the window over: 2 cells used, 7 of slack, the clock at boundary 9.
  { kind: "five_hour", percentUsed: 22, resetsAt: new Date(NOW + 39 * 60_000).toISOString() },
  // 7 days: 29% used, 24.6% of the window over: 2 cells within, the clock at boundary 2, 1 cell ahead.
  { kind: "seven_day", percentUsed: 29, resetsAt: new Date(NOW + 5.278 * 86_400_000).toISOString() },
];

test("bar: in the terminal, use within the pace, ahead of it, the slack and the clock", async ($, on) => {
  world(on);
  withUsage(on, PACED);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { ui, texts } = await band($, "terminal");
  expect(await bars(ui)).toEqual(["━━╌╌╌╌╌╌╌│─", "━━│━───────"]);
  expect(texts).toContain("▼65");
  expect(texts).toContain("▲4");
  // The use in the window's color, the lead in the tone's, the slack dimmed, the clock in grey.
  const lines = (await ui.findAll({ type: "Text", text: "━" })) as any[];
  expect(lines.map((t) => t.props?.color)).toEqual(["#3a9a62", "#3a9a62", "#8a5fd0", "#8a5fd0", "#d9962b"]);
  expect(((await ui.find({ type: "Text", text: "╌" })) as any)?.props?.dimColor).toBe(true);
  expect(((await ui.find({ type: "Text", text: "│" })) as any)?.props?.color).toBe("#d6d9de");
});

test("bar: in the app, a drawn rail with the clock as a mark", async ($, on) => {
  world(on);
  withUsage(on, PACED);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  const { ui, texts } = await band($, "desktop");
  expect(await bars(ui)).toEqual([]);
  const [five, seven] = await rails(ui);
  // Behind the clock: the slack in the window's color, faint, up to the clock.
  expect(five).toContain('fill="#3a9a62" fill-opacity="0.3"');
  expect(five).toContain('fill="#8a8f98"');
  // Ahead of the clock: the lead in amber.
  expect(seven).toContain('fill="#d9962b"');
  expect(texts).toContain("29%");
});

for (const surface of ["terminal", "desktop"] as const) {
  test(`bar: no clock without a window length ${surface}`, async ($, on) => {
    world(on);
    withUsage(on, [{ kind: "spend_limit", percentUsed: 40 }]);
    await $.session.start({ source: "startup", cwd: "/tmp" } as any);
    const { ui } = await band($, surface);
    if (surface === "terminal") expect(await bars(ui)).toEqual(["━━━━──────"]);
    else expect((await rails(ui))[0]).toContain('fill="#b8892a"');
    if (surface === "desktop") expect((await rails(ui))[0]).not.toContain("#8a8f98");
  });
}

for (const surface of ["terminal", "desktop"] as const) {
  test(`rows: context, cache and agents above, 5h and 7d below ${surface}`, async ($, on) => {
    world(on);
    withUsage(on, LIMITS);
    on("agent.list", () => ({ value: [{ id: "a1", description: "Job", type: "Plan", status: "running" }] }));
    await $.session.start({ source: "startup", cwd: "/tmp" } as any);
    const { ui, texts } = await band($, surface);
    const boxes = (await ui.findAll({ type: "Box" })) as any[];
    const keys = boxes.map((b) => b.props?.key);
    expect(keys.indexOf("row-status")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("row-status")).toBeLessThan(keys.indexOf("row-limits"));
    const ctx = texts.indexOf("107k");
    const agents = texts.findIndex((t: string) => t === "Plan" || t === "1 agent");
    expect(texts.indexOf("—")).toBeGreaterThan(ctx);
    expect(agents).toBeGreaterThan(texts.indexOf("—"));
    expect(texts.indexOf("5h")).toBeGreaterThan(agents);
    expect(texts.indexOf("7d")).toBeGreaterThan(texts.indexOf("5h"));
  });
}
