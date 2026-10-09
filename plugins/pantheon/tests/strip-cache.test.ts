import { test, expect } from "claude-code/testing";
import { NOW, at, LIMITS, world, withUsage, band, cardOf, step, engineStep, HIT, sessionStart, turnComplete, compact, stepWith, tick, engine, fake } from "./strip-helpers";

// ---------- Prompt cache ----------

const MISS = { model: "claude-opus-5-5", input_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 99_700, output_tokens: 500 };

// The cache pill's hover card in the app; null without one.
async function boltTip(ui: any): Promise<string | null> {
  return cardOf(ui, "cache");
}

test("cache: share read and time left on a subscription (1 hour)", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  engineStep(on, [HIT]);
  await sessionStart($, { source: "startup", cwd: "/tmp" });
  await step($, HIT);
  const { ui, texts } = await band($, "terminal");
  expect(texts).toContain("cache");
  // The time left (1 hour, counted from the request's start), then the share read in a block of its own.
  expect(texts).toContain("1h");
  expect(texts).toContain("hit");
  expect(texts).toContain("98%");
  expect(texts.indexOf("1h")).toBeLessThan(texts.indexOf("hit"));
  const time: any = await ui.find({ type: "Text", text: "1h" });
  expect(time?.props?.bold).toBe(true);
  expect(time?.props?.color).toBeUndefined();
  expect(((await ui.find({ type: "Text", text: "98%" })) as any)?.props?.color).toBeUndefined();
  // In the app, the hit pill's hover card says how much was read.
  expect(await cardOf((await band($, "desktop")).ui, "hit")).toBe("Last message: 98% read from the cache (98k).");
});

test("cache: yellow under 10 minutes, then expired with /compact", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  engineStep(on, [HIT]);
  await sessionStart($, { source: "startup", cwd: "/tmp" });
  await step($, HIT);
  await (clock as any).advance(55 * 60_000);
  let { ui, texts } = await band($, "terminal");
  expect(texts).toContain("5m");
  const soon: any = await ui.find({ type: "Text", text: "5m" });
  expect(soon?.props?.color).toBe("#e0a030");
  // Under 10 minutes: signaled by color alone, no warning mark.
  expect(soon?.props?.bold).toBe(true);
  expect(texts).not.toContain("⚠");
  // What letting it lapse writes again: the 107k context, dim.
  const stake: any = await ui.find({ type: "Text", text: "· 107k at stake" });
  expect(stake?.props?.dimColor).toBe(true);
  const desktop = await band($, "desktop");
  expect(desktop.texts).toContain("107k at stake");
  const yellow: any = await desktop.ui.find({ type: "Text", text: "5m" });
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
  await sessionStart($, { source: "startup", cwd: "/tmp" });
  await step($, HIT);
  await step($, MISS, "claude-sonnet-5-5");
  const { texts } = await band($, "terminal");
  // The time stays; the hit block turns yellow with the cause.
  expect(texts).toContain("1h");
  expect(texts).toContain("0%");
  expect(texts).toContain("· missed · model changed");
  const desktop = await band($, "desktop");
  expect(desktop.texts).toContain("missed · model changed");
  expect(((await desktop.ui.find({ type: "Text", text: "0%" })) as any)?.props?.color).toBe("#a8690a");
  expect(await cardOf(desktop.ui, "hit")).toBe("This message read only 0% from the cache (model changed): it wrote 99.7k tokens again.");
});

test("cache: 5 minutes on an API key (no plan window)", async ($, on) => {
  world(on);
  withUsage(on, []);
  engineStep(on, [HIT]);
  await sessionStart($, { source: "startup", cwd: "/tmp" });
  await step($, HIT);
  const { ui, texts } = await band($, "terminal");
  expect(texts).toContain("5m");
  // The lifetime is in sight, and a fresh 5-minute cache is not yellow (the threshold follows the lifetime).
  expect(texts.join(" ")).toContain("5m TTL · x1.25");
  const time: any = await ui.find({ type: "Text", text: "5m" });
  expect(time?.props?.color).toBeUndefined();
});

test("cache: 5 minutes shows x1.25, and expired keeps the same format", async ($, on) => {
  const clock = world(on);
  withUsage(on, []);
  engineStep(on, [HIT]);
  await sessionStart($, { source: "startup", cwd: "/tmp" });
  await step($, HIT);
  await clock.advance(6 * 60_000);
  const { ui, texts } = await band($, "terminal");
  expect(texts).toContain("expired");
  // Expired: the lifetime and the write multiplier stay beside it, before the advice.
  expect(texts).toContain("· 107k to rewrite · 5m TTL · x1.25 · /compact");
  expect(((await ui.find({ type: "Text", text: "expired" })) as any)?.props?.color).toBe("#ff6b6b");
});

test("cache: the yellow threshold is a sixth of the lifetime (50 s of 5 minutes)", async ($, on) => {
  const clock = world(on);
  withUsage(on, []);
  engineStep(on, [HIT]);
  await sessionStart($, { source: "startup", cwd: "/tmp" });
  await step($, HIT);
  await clock.advance(4 * 60_000);
  let { ui, texts } = await band($, "terminal");
  expect(texts).toContain("1m");
  expect(((await ui.find({ type: "Text", text: "1m" })) as any)?.props?.color).toBeUndefined();
  await clock.advance(20_000);
  ({ ui, texts } = await band($, "terminal"));
  // 40 s left: under 50 s.
  expect(texts).toContain("< 1m");
  expect(((await ui.find({ type: "Text", text: "< 1m" })) as any)?.props?.color).toBe("#e0a030");
});

test("desktop icons: gauge centred at y=12", async ($, on) => {
  world(on);
  withUsage(on, LIMITS, { tokens: 400_000, window: 1_000_000, percent: 40 });
  await sessionStart($, { source: "resume", cwd: "/tmp" });
  const { ui } = await band($, "desktop");
  const svgs = (await ui.findAll({ type: "Svg" })) as any[];
  const source = (alt: string) => String(svgs.find((s) => s.props?.alt === alt)?.props?.source);
  expect(source("5-hour limit")).toContain('<g transform="translate(0 0.5)"><path d="M3.6 18.5');
});

test("cache expired from 300k: what gets written again, and a new thread", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS, { tokens: 741_000, window: 1_000_000, percent: 74 });
  engineStep(on, [HIT]);
  await sessionStart($, { source: "resume", cwd: "/tmp" });
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

test("desktop: pills never shrink, and the 5-hour reset time sits in the pill's hover card", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  await sessionStart($, { source: "startup", cwd: "/tmp" });
  const { ui } = await band($, "desktop");
  const pills = ((await ui.findAll({ type: "Box" })) as any[]).filter((b) => b.props?.backgroundColor && b.props?.position !== "absolute");
  for (const p of pills) expect(p.props?.flexShrink).toBe(0);
  expect(await cardOf(ui, "gauge-5h")).toBe(`Resets at ${at(NOW + 3 * 3_600_000)}`);
});

// ---------- Compaction ----------

// A large thread whose cache expired, as the band showed it before a /compact.
// What the compaction under the strip answered (the engine's result).
let COMPACTION: any;

async function largeExpired($: any, on: any, compaction: Record<string, unknown>) {
  const clock = world(on);
  COMPACTION = compaction;
  withUsage(on, LIMITS, { tokens: 784_000, window: 1_000_000, percent: 78 });
  engineStep(on, [
    { ...HIT, cache_read_input_tokens: 780_000 },
    // The first request after the compaction writes the whole, smaller, context.
    { ...MISS, cache_creation_input_tokens: 47_700 },
  ]);
  await sessionStart($, { source: "resume", cwd: "/tmp" });
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
  await compact($, COMPACTION);
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
  expect(next.texts).toContain("1h");
});

test("compaction: a skipped one changes nothing", async ($, on) => {
  await largeExpired($, on, { skip: "blocked by a hook" });
  await compact($, COMPACTION);
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
  await sessionStart($, { source: "startup", cwd: "/tmp" });
  await step($, BIG_HIT);
  await step($, BIG_HIT);
  expect(await boltTip((await band($, "desktop")).ui)).toBe(
    [
      `Cache warm until ${at(NOW + 3_600_000)} (1-hour lifetime, assumed).`,
    ].join("\n"),
  );
});

test("cache: under 10 minutes and under 90% served, the stake after the time, the share apart", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  const PART = { ...HIT, cache_read_input_tokens: 72_000, cache_creation_input_tokens: 0, input_tokens: 28_000 };
  engineStep(on, [PART]);
  await sessionStart($, { source: "startup", cwd: "/tmp" });
  await step($, PART);
  await clock.advance(55 * 60_000);
  const { ui, texts } = await band($, "terminal");
  const time: any = await ui.find({ type: "Text", text: "5m" });
  expect(time?.props?.color).toBe("#e0a030");
  expect(texts).toContain("· 107k at stake");
  expect(texts.indexOf("5m")).toBeLessThan(texts.indexOf("· 107k at stake"));
  // The share is no miss: its own block after the time, in the theme's color.
  const share: any = await ui.find({ type: "Text", text: "72%" });
  expect(share?.props?.color).toBeUndefined();
  expect(share?.props?.bold).toBe(true);
  expect(texts.indexOf("· 107k at stake")).toBeLessThan(texts.indexOf("72%"));
});

test("cache expired at 150k: the size in the pill, /compact in the tooltip", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS, { tokens: 150_000, window: 1_000_000, percent: 15 });
  engineStep(on, [HIT]);
  await sessionStart($, { source: "startup", cwd: "/tmp" });
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
  await sessionStart($, { source: "startup", cwd: "/tmp" });
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
