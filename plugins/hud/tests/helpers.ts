import { mock } from "claude-code/testing";

// October 2, 2026, 13:00 UTC.
export const NOW = Date.UTC(2026, 9, 2, 13, 0);
// The 5-hour reset time is shown in the machine's time zone.
export const at = (ms: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
export const LIMITS = [
  // 7 days: 59% used, 4 of 7 days elapsed (57%): slightly ahead, yellow.
  { kind: "seven_day", percentUsed: 59, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
  // 5 hours: 32% used, 2 of 5 hours elapsed (40%): behind time, green.
  { kind: "five_hour", percentUsed: 32, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
];

// below: what a mod placed after this one draws under the line.
export function world(on: any, env: Record<string, string> = {}, stored: Record<string, unknown> = {}, below?: string) {
  const clock = mock.clock(on, { now: NOW });
  mock.store(on, stored);
  mock.env(on, env);
  on("session.id", () => ({ value: "session-1" }));
  on("session.start", (_$: any, e: any) => ({ cwd: e.cwd ?? "/tmp" }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.render", ($: any, e: any) => (below ? $.ui.resolve(e).Text({ children: below }) : $.ui.resolve(e).Box({ children: [] })));
  return clock as any;
}

export function withUsage(on: any, rateLimits: unknown[], context = { tokens: 107_000, window: 1_000_000, percent: 11 }) {
  on("session.usage", () => ({ value: { startedAt: NOW, context, rateLimits } }));
}

export async function band($: any, surface: "terminal" | "desktop", columns = 200) {
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
export async function cardNodes(ui: any): Promise<any[]> {
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
export async function cardOf(ui: any, pillKey: string): Promise<string | null> {
  const pill: any = await ui.find({ type: "Box", key: pillKey });
  const kids = (pill?.children ?? []) as any[];
  const card = kids.find((c) => c && typeof c === "object" && c.props?.position === "absolute");
  if (!card) return null;
  const lines = ((card.children ?? card.props?.children ?? []) as any[]).map((t) => strings(t).join(""));
  return lines.join("\n");
}

// One main-loop request answered with this usage.
export async function step($: any, usage: Record<string, unknown>, model = "claude-opus-5-5") {
  const stream = $.turn.step({ turnId: "t", index: 0, model, messageCount: 2 });
  for await (const _ of stream) {
  }
  return stream.result;
}

export function engineStep(on: any, usages: Record<string, unknown>[]) {
  let call = 0;
  on("turn.step", async function* () {
    const usage = usages[Math.min(call++, usages.length - 1)];
    return { turnId: "t", index: 0, answer: "", toolUses: [], stopReason: "end_turn", usage };
  });
}

export const HIT = { model: "claude-opus-5-5", input_tokens: 300, cache_read_input_tokens: 98_000, cache_creation_input_tokens: 1_700, output_tokens: 500 };
const COMMANDS = [
  { name: "review-pr", description: "Review a pull request", source: "plugin" },
  { name: "clear", description: "Clear the conversation", source: "builtin" },
];
export const ITEMS = [
  { label: "Run the tests", prompt: "run the tests you just wrote" },
  { label: "Commit", prompt: "commit the change" },
  { label: "Open the PR", prompt: "open a pull request" },
];
const ANSWER = "x".repeat(200);

// The detached fork finishes some ticks after the turn does.
export async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

// What the fork answers; fork prompts and ghost texts are recorded.
export function suggesting(on: any, reply: unknown, options: { commands?: unknown[]; fork?: () => Promise<unknown>; complete?: () => Promise<unknown> } = {}) {
  const seen = { forks: [] as string[], completions: [] as any[], logs: [] as string[], ghosts: [] as string[] };
  on("command.list", () => ({ value: options.commands ?? COMMANDS }));
  on("ui.log", (_$: any, e: any) => { seen.logs.push(e.text); return { value: undefined }; });
  on("model.complete", async (_$: any, e: any) => {
    seen.completions.push(e);
    if (options.complete) return { value: await options.complete() };
    return { value: { isAnswered: true, text: typeof reply === "string" ? reply : JSON.stringify(reply), usage: {} } };
  });
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

export async function turnDone($: any, extra: Record<string, unknown> = {}) {
  await ($ as any).turn.complete({ reason: "answer", answer: ANSWER, turnId: "t1", durationMs: 1, isAborted: false, ...extra } as any);
  await settle();
}
