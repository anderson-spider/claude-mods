import { test, expect } from "claude-code/testing";
import { LIMITS, world, withUsage, band, sessionStart, turnComplete, compact, stepWith, tick, engine, fake } from "./strip-helpers";

// ---------- Info line: model·effort | repository | branch ⎇wt · changes ----------

// A fake git by subcommand; `repo: false` answers every one as outside a repository, and `dirty`
// puts that many changed files and a diff of 70 added and 4 removed lines in the working tree.
// `worktree` answers rev-parse as a linked worktree of /work/claude-mods.
function hostInfo(_on: any, { branch = "andersonsilva/feat", model = "claude-sonnet-5-5" as string | (() => string), repo = true, dirty = 0, worktree = false } = {}) {
  fake.cwd = "/work/spider-marketplace";
  fake.model = () => (typeof model === "function" ? model() : model);
  fake.run = (argv: string[]) => {
    const out = (exitCode: number, stdout = "") => ({ exitCode, stdout });
    if (!repo) return out(128);
    if (argv.includes("branch")) return out(0, branch + "\n");
    if (argv.includes("rev-parse")) {
      return out(0, worktree ? "/work/claude-mods/.git/worktrees/lucky-field\n/work/claude-mods/.git\n" : "/work/spider-marketplace/.git\n/work/spider-marketplace/.git\n");
    }
    if (argv.includes("status")) return out(0, Array.from({ length: dirty }, (_, i) => ` M file${i}.ts\n`).join(""));
    if (argv.includes("diff")) return out(0, "60\t3\tplugins/hud/hooks/hud.mjs\n10\t1\tplugins/hud/tests/hud.test.ts\n-\t-\timage.png\n");
    return out(1);
  };
}

// A main-loop request that takes `ms` and writes `tokens`.
function slowStep(on: any, clock: any, ms: number, tokens: number) {
  engine.step = async () => {
    await clock.advance(ms);
    return { turnId: "t", index: 0, answer: "", toolUses: [], stopReason: "end_turn", usage: { model: "claude-sonnet-5-5", input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: tokens } };
  };
}

test("info: the model, folder and branch show above the usage line before any request", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  const { texts } = await band($, "terminal");
  expect(texts).toContain("claude-sonnet-5-5".replace("claude-", "").replace(/^s/, "S").replace("-5-5", " 5.5"));
  expect(texts).toContain("spider-marketplace");
  expect(texts).toContain("andersonsilva/feat");
  expect(texts.indexOf("spider-marketplace")).toBeLessThan(texts.indexOf("107k"));
});

test("info: the effort comes from the last request, hung on the model; no speed", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  slowStep(on, clock, 5000, 360);
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  await stepWith($, { model: "claude-opus-5-5", effort: "high" });
  const { texts } = await band($, "terminal");
  expect(texts).toContain("Opus 5.5");
  expect(texts).toContain("·high");
  expect(texts.indexOf("·high")).toBe(texts.indexOf("Opus 5.5") + 1);
  expect(texts.some((t) => t.endsWith("tok/s"))).toBe(false);
});

test("info: a /model switch shows within the 10 s tick, and the old effort goes", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  let model = "claude-sonnet-5-5";
  hostInfo(on, { model: () => model });
  slowStep(on, clock, 5000, 360);
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  await stepWith($, { model: "claude-sonnet-5-5", effort: "high" });
  expect((await band($, "terminal")).texts).toContain("·high");
  // Same model: the request's own id and effort stay.
  await clock.advance(10_000);
  await tick($);
  expect((await band($, "terminal")).texts).toContain("·high");
  model = "claude-opus-5-5";
  await clock.advance(10_000);
  await tick($);
  const { texts } = await band($, "terminal");
  expect(texts).toContain("Opus 5.5");
  expect(texts).not.toContain("Sonnet 5.5");
  expect(texts).not.toContain("·high");
});

test("info: outside a git repository the branch is left out", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on, { repo: false });
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  const { texts } = await band($, "terminal");
  expect(texts).toContain("spider-marketplace");
  expect(texts).not.toContain("andersonsilva/feat");
});

test("info: on a narrow terminal the effort and folder go first and the branch stays", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  slowStep(on, clock, 5000, 360);
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  await stepWith($, { model: "claude-sonnet-5-5", effort: "high" });
  const { texts } = await band($, "terminal", 40);
  expect(texts).toContain("Sonnet 5.5");
  expect(texts).toContain("andersonsilva/feat");
  expect(texts).not.toContain("·high");
  expect(texts).not.toContain("spider-marketplace");
});

test("info: the desktop draws the same info line, above the band", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  const { texts } = await band($, "desktop");
  expect(texts).toContain("Sonnet 5.5");
  expect(texts).toContain("andersonsilva/feat");
  expect(texts.indexOf("andersonsilva/feat")).toBeLessThan(texts.indexOf("107k"));
});

test("info: in the desktop, the model, repository and branch are outlined pills", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on, { worktree: true, dirty: 1 });
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  const { ui, texts } = await band($, "desktop");
  const pills = ((await ui.findAll({ type: "Box" })) as any[]).filter((b) => String(b.props?.key ?? "").startsWith("info-"));
  expect(pills.map((b) => b.props.key)).toEqual(["info-model", "info-dir", "info-branch"]);
  for (const b of pills) expect(b.props.borderStyle).toBe("round");
  // Set apart from the rows of pills below it.
  expect(((await ui.find({ type: "Box", key: "info" })) as any)?.props?.marginBottom).toBe(1);
  // The branch pill carries its marks: the worktree and the changes.
  expect(texts.indexOf("⎇wt")).toBe(texts.indexOf("andersonsilva/feat*") + 1);
  expect(texts).toContain("+70");
  expect(texts.slice(0, texts.indexOf("107k"))).not.toContain("|");
});

test("info: in a worktree, the repository's name and ⎇wt after the branch", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on, { worktree: true });
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  const { texts } = await band($, "terminal");
  expect(texts).toContain("claude-mods");
  expect(texts).not.toContain("spider-marketplace");
  expect(texts.indexOf("⎇wt")).toBe(texts.indexOf("andersonsilva/feat") + 1);
});

test("info: outside a worktree, no ⎇wt", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  expect((await band($, "terminal")).texts).not.toContain("⎇wt");
});

test("info: the changed files and lines hang on the branch", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on, { dirty: 1 });
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  const { texts } = await band($, "terminal");
  expect(texts).toContain("· 1 file");
  expect(texts).toContain("+70");
  expect(texts).toContain("-4");
});

test("info: a branch with changes is red with a star, a clean one green", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on, { dirty: 1 });
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  const dirty: any = await (await band($, "terminal")).ui.find({ type: "Text", text: "andersonsilva/feat*" });
  expect(dirty.props?.color).toBe("#ff6b6b");
});

test("info: a clean branch is green and has no star", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  const clean: any = await (await band($, "terminal")).ui.find({ type: "Text", text: "andersonsilva/feat" });
  expect(clean.props?.color).toBe("#6fcf97");
});

test("info: several changed files are counted in the plural", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on, { dirty: 3 });
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  expect((await band($, "terminal")).texts).toContain("· 3 files");
});

test("info: a clean tree shows no changes", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  await sessionStart($, { source: "startup", cwd: "/work/spider-marketplace" });
  expect((await band($, "terminal")).texts.some((t) => /^· \d+ files?$/.test(t))).toBe(false);
});
