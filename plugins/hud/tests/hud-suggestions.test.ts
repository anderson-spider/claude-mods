import { test, expect } from "claude-code/testing";
import { LIMITS, world, withUsage, band, ITEMS, suggesting, turnDone, settle } from "./helpers";

// ---------- Next steps: the suggestions after a turn ----------

test("suggestions: default completes with only the latest request and answer", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  const submitted: any[] = [];
  on("prompt.submit", (_$: any, e: any) => { submitted.push(e); return { text: e.text }; });
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await $.prompt.submit({ text: "old request" } as any);
  await turnDone($, { answer: "old answer ".repeat(20) });
  const result = await $.prompt.submit({ text: "latest request" } as any);
  expect(result).toEqual({ text: "latest request" });
  expect(submitted.map((e) => e.text)).toEqual(["old request", "latest request"]);
  await ($ as any).turn.start({ text: "agent request", turnId: "agent", agentId: "a1" });
  await turnDone($, { answer: "latest answer ".repeat(20), turnId: "t2" });
  expect(seen.forks).toEqual([]);
  const call = seen.completions[1];
  expect(call.model).toBe("haiku");
  expect(call.effort).toBe("low");
  expect(call.maxTokens).toBe(600);
  expect(call.timeoutMs).toBe(20000);
  expect(call.prompt).toContain("<request>\nlatest request\n</request>");
  expect(call.prompt).toContain("latest answer");
  expect(call.prompt).not.toContain("old request");
  expect(call.prompt).not.toContain("old answer");
  expect(call.prompt).not.toContain("agent request");
  expect(call.prompt).not.toContain("Do not continue the task");
  expect(call.prompt).toContain("/review-pr: Review a pull request");
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.completions[2].prompt).toContain("<request>\n\n</request>");
  expect(seen.completions[2].prompt).not.toContain("latest request");
});

test("suggestions: Haiku omits skills when disabled and clips context", { options: { suggestSkills: false } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  on("prompt.submit", (_$: any, e: any) => ({ text: e.text }));
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await $.prompt.submit({ text: "r".repeat(3100) } as any);
  await turnDone($, { answer: "a".repeat(6100) });
  expect(seen.completions[0].prompt).toContain(`<request>\n${"r".repeat(2999)}…\n</request>`);
  expect(seen.completions[0].prompt).toContain(`<answer>\n${"a".repeat(5999)}…\n</answer>`);
  expect(seen.completions[0].prompt).not.toContain("<available-skills>");
});

test("suggestions: an unanswered Haiku call logs and offers nothing without fallback", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS, { complete: async () => ({ isAnswered: false, reason: "api-error" }) });
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.completions.length).toBe(1);
  expect(seen.forks).toEqual([]);
  expect(seen.ghosts).toEqual([]);
  expect(seen.logs.join(" ")).toContain("api-error");
  expect((await band($, "terminal")).texts).not.toContain("next:");
});

test("suggestions: a long answer forks and offers the first prompt as ghost text", { options: { suggestionModel: "fork" } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.forks.length).toBe(1);
  expect(seen.completions).toEqual([]);
  expect(seen.ghosts).toEqual(["run the tests you just wrote"]);
});

test("suggestions: an answer under minAnswerChars makes no fork", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($, { answer: "x".repeat(20) });
  expect(seen.forks.length).toBe(0);
  expect(seen.completions).toEqual([]);
});

test("suggestions: minAnswerChars is a setting", { options: { minAnswerChars: 10 } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($, { answer: "x".repeat(20) });
  expect(seen.completions.length).toBe(1);
});

test("suggestions: a subagent's turn makes no fork", async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($, { agentId: "a1" });
  expect(seen.forks.length).toBe(0);
  expect(seen.completions).toEqual([]);
});

test("suggestions: the fork is told the session's skills", { options: { suggestionModel: "fork" } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS);
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.forks[0]).toContain("/review-pr: Review a pull request");
  expect(seen.forks[0]).not.toContain("/clear");
});

test("suggestions: without suggestSkills the fork gets no skill list", { options: { suggestSkills: false, suggestionModel: "fork" } } as any, async ($, on) => {
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

test("suggestions: prose, bad JSON, an unanswered or a failing fork offer nothing", { options: { suggestionModel: "fork" } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, "I would suggest running the tests.");
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.forks.length).toBe(1);
  expect(seen.ghosts).toEqual([]);
});

test("suggestions: a fork that throws offers nothing and does not break the turn", { options: { suggestionModel: "fork" } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS, { fork: () => Promise.reject(new Error("boom")) });
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.ghosts).toEqual([]);
});

test("suggestions: a result that arrives after a newer turn is dropped", { options: { suggestionModel: "fork" } } as any, async ($, on) => {
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

test("suggestions: a wait line while the fork runs", { options: { suggestionModel: "fork" } } as any, async ($, on) => {
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

test("suggestions: the desktop draws the block above the line", async ($, on) => {
  await offered($, on);
  const { texts } = await band($, "desktop");
  expect(texts).toContain("next:");
  expect(texts.indexOf("next:")).toBeLessThan(texts.indexOf("107k"));
});

// ---------- Next steps: filling a suggestion as a draft ----------

// An offer with prompt.fill answering as told; the filled texts and the toasts are recorded.
async function filling($: any, on: any, fill: "filled" | "refused" | "rejects" = "filled", items: unknown[] = ITEMS) {
  const filled: string[] = [];
  const toasts: string[] = [];
  const submitted: string[] = [];
  on("prompt.submit", (_$: any, e: any) => {
    submitted.push(e.text);
    return { turnId: "unexpected" };
  });
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
  return { filled, toasts, submitted };
}

async function press($: any, ...keys: string[]) {
  for (const key of keys) await (await band($, "terminal")).ui.press({ key } as any);
  return labels((await band($, "terminal")).ui);
}

for (const [key, prompt] of [
  ["fill-1", "run the tests you just wrote"],
  ["fill-2", "commit the change"],
  ["fill-3", "open a pull request"],
]) {
  test(`filling: ${key} fills its prompt directly without submitting`, async ($, on) => {
    const { filled, toasts, submitted } = await filling($, on);
    await press($, key);
    expect(filled).toEqual([prompt]);
    expect(toasts).toEqual([]);
    expect(submitted).toEqual([]);
    expect((await band($, "terminal")).texts).not.toContain("next:");
  });
}

test("filling: a new offer shows the same numbered labels", async ($, on) => {
  await filling($, on);
  await press($, "fill-1");
  await turnDone($, { turnId: "t2" });
  const { ui } = await band($, "terminal");
  expect(await labels(ui)).toEqual(["Run the tests", "Commit", "Open the PR", "dismiss"]);
  expect(((await ui.findAll({ type: "Button" })) as any[]).map((button) => button.props.hotkey)).toEqual(["1", "2", "3", "0"]);
});

test("filling: a fill that is not accepted hides the block and shows a toast", async ($, on) => {
  const { filled, toasts, submitted } = await filling($, on, "refused");
  await press($, "fill-1");
  expect(filled).toEqual(["run the tests you just wrote"]);
  expect(toasts).toEqual(["could not fill the prompt box"]);
  expect(submitted).toEqual([]);
  expect((await band($, "terminal")).texts).not.toContain("next:");
});

test("filling: a fill that rejects hides the block and shows a toast", async ($, on) => {
  const { toasts, submitted } = await filling($, on, "rejects");
  await press($, "fill-1");
  expect(toasts.length).toBe(1);
  expect(toasts[0]).toContain("could not fill:");
  expect(submitted).toEqual([]);
  expect((await band($, "terminal")).texts).not.toContain("next:");
});

test("filling: a slash suggestion is filled as it is", async ($, on) => {
  const { filled, submitted } = await filling($, on, "filled", [
    { label: "Review", prompt: "/review-pr 12" },
    { label: "Commit", prompt: "commit the change" },
  ]);
  await press($, "fill-1");
  expect(filled).toEqual(["/review-pr 12"]);
  expect(submitted).toEqual([]);
});

test("filling: model text is cleaned before it reaches the label or prompt", async ($, on) => {
  const { filled, submitted } = await filling($, on, "filled", [
    { label: "Run\u001b[31m\u200b tests", prompt: "run\u001b[31m\u200b  the\n tests" },
  ]);
  expect(await labels((await band($, "terminal")).ui)).toEqual(["Run tests", "dismiss"]);
  await press($, "fill-1");
  expect(filled).toEqual(["run the tests"]);
  expect(submitted).toEqual([]);
});

// ---------- Next steps: the deferred review minors ----------

test("suggestions: invalid JSON offers nothing", { options: { suggestionModel: "fork" } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, '[{"label": "Run", "prompt": "run the tests"');
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.forks.length).toBe(1);
  expect(seen.ghosts).toEqual([]);
  expect((await band($, "terminal")).texts).not.toContain("next:");
});

test("suggestions: a fork that is not answered offers nothing", { options: { suggestionModel: "fork" } } as any, async ($, on) => {
  world(on);
  withUsage(on, LIMITS);
  const seen = suggesting(on, ITEMS, { fork: async () => ({ isAnswered: false, reason: "api-error" }) });
  await $.session.start({ source: "startup", cwd: "/tmp" } as any);
  await turnDone($);
  expect(seen.forks.length).toBe(1);
  expect(seen.ghosts).toEqual([]);
  expect((await band($, "terminal")).texts).not.toContain("next:");
});

test("filling: a press from an older, longer offer fills nothing", { options: { suggestionModel: "fork" } } as any, async ($, on) => {
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
  await old.press({ key: "fill-3" } as any).catch(() => undefined);
  expect(await labels((await band($, "terminal")).ui)).toEqual(["Run the tests", "dismiss"]);
  expect(filled).toEqual([]);
});

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
