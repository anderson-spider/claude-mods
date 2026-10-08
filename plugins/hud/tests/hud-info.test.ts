import { test, expect } from "claude-code/testing";
import { LIMITS, world, withUsage, band } from "./helpers";

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

test("agents: in the terminal, running subagents show their models on the usage line; the info line keeps the session's", async ($, on) => {
  const clock = world(on);
  withUsage(on, LIMITS);
  hostInfo(on);
  slowStep(on, clock, 5000, 360);
  let list = [
    { id: "a1", description: "Job", type: "general-purpose", status: "running" },
    { id: "a2", description: "Loop", type: "general-purpose", status: "running" },
    { id: "a3", description: "Plan", type: "Plan", status: "running" },
  ];
  on("agent.list", () => ({ value: list }));
  on("turn.complete", () => ({ text: "" }));
  await $.session.start({ source: "startup", cwd: "/work/spider-marketplace" } as any);
  for (const [agentId, model] of [[undefined, "claude-opus-5-5"], ["a1", "claude-haiku-5-5"], ["a2", "claude-haiku-5-5"]]) {
    for await (const _ of $.turn.step({ turnId: "t", index: 0, model, messageCount: 2, ...(agentId ? { agentId } : {}) } as any)) {
    }
  }
  let { texts } = await band($, "terminal");
  expect(texts).toContain("Opus 5.5");
  expect(texts).toContain("2× Haiku 5.5 · agent");
  expect(texts).not.toContain("Haiku 5.5");
  list = list.map((a) => ({ ...a, status: "completed" }));
  await ($ as any).turn.complete({ answer: "ok", agentId: "a1" } as any);
  ({ texts } = await band($, "terminal"));
  expect(texts).toContain("Opus 5.5");
  expect(texts.some((t: string) => t.includes("Haiku"))).toBe(false);
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
