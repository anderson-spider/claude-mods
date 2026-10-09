import { renderStrip } from "../hooks/strip/render";
import { configureStrip, startStrip, tickStrip, noteStep, noteTurnComplete, noteCompact, type StripHost } from "../hooks/strip/state";
import type { AgentView } from "../hooks/strip/agents";

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

// The strip's hooks live in register.tsx (a later task), and the `$` a test holds only reaches the
// host calls that module's source names. So these tests drive the strip modules the way the hooks
// will, with a fake host of their own (clock, store, usage, git) and plain element constructors.
export const fake: {
  now: number; env: Record<string, string>; below?: string; stored: Map<string, unknown>
  usage: () => any; cwd: string | null; model: () => string; run: (argv: string[]) => { exitCode: number; stdout: string }
} = { now: NOW, env: {}, stored: new Map(), usage: () => ({ rateLimits: [] }), cwd: null, model: () => "", run: () => ({ exitCode: 128, stdout: "" }) };
export const engine: { step?: (e?: any) => any } = {};
export const testAgents: { list: AgentView[] } = { list: [] };

// below: what a mod placed after this one draws under the strip.
export function world(_on?: any, env: Record<string, string> = {}, stored: Record<string, unknown> = {}, below?: string, stripOptions: Record<string, unknown> = {}) {
  Object.assign(fake, { now: NOW, env, below, stored: new Map(Object.entries(stored)), usage: () => ({ rateLimits: [] }), cwd: null, model: () => "", run: () => ({ exitCode: 128, stdout: "" }) });
  testAgents.list = [];
  delete engine.step;
  configureStrip(stripOptions);
  return { advance: async (ms: number) => { fake.now += ms; }, now: () => fake.now };
}

export function hostOf(_$?: any): StripHost {
  return {
    now: async () => fake.now, sessionId: async () => "session-1", cwd: async () => { if (fake.cwd === null) throw new Error("no folder"); return fake.cwd; }, model: async () => fake.model(),
    run: async (argv) => fake.run(argv), usage: async () => fake.usage(),
    storeKeys: async () => [...fake.stored.keys()], storeGet: async (k) => fake.stored.get(k),
    storeSet: async (k, v) => { fake.stored.set(k, v); }, storeDelete: async (k) => { fake.stored.delete(k); },
  };
}

export async function sessionStart($: any, _e?: unknown) {
  const v = fake.env;
  await startStrip(hostOf($), { off: v.DISABLE_PROMPT_CACHING ?? "", force5m: v.FORCE_PROMPT_CACHING_5M ?? "", ttl: v.CLAUDE_CODE_PROMPT_CACHE_TTL ?? "", enable1h: v.ENABLE_PROMPT_CACHING_1H ?? "" });
}
export async function turnComplete($: any, _e?: unknown) { await noteTurnComplete(hostOf($)); }
export async function compact($: any, result: any, e: any = { trigger: "manual" }) { await noteCompact(hostOf($), e, result); }
export async function tick($: any, agentsChanged = false) { return tickStrip(hostOf($), agentsChanged); }

// A tiny element table: what the engine's `find` would see (type, key, props, children, text).
const strings = (node: any): string[] => {
  if (node == null || node === false) return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(strings);
  return strings(node.children ?? node.props?.children);
};
const make = (type: string) => (props: any = {}) => {
  const node: any = { type, key: props.key, props, children: props.children };
  if (type === "Text") node.text = strings(props.children).join("");
  return node;
};
export const elements = { Box: make("Box"), Text: make("Text"), Svg: make("Svg"), Button: make("Button") };

const walk = (node: any, out: any[] = []): any[] => {
  if (node == null || node === false || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (node.type) out.push(node);
  walk(node.children, out);
  return out;
};
function treeUi(tree: any) {
  const all = () => walk(tree);
  const match = (n: any, q: any) => n.type === q.type && (q.key === undefined || n.key === q.key) && (q.text === undefined || n.text === q.text);
  return { find: async (q: any) => all().find((n) => match(n, q)) ?? null, findAll: async (q: any) => all().filter((n) => match(n, q)) };
}

export function withUsage(_on: any, rateLimits: unknown[], context = { tokens: 107_000, window: 1_000_000, percent: 11 }) {
  fake.usage = () => ({ startedAt: NOW, context, rateLimits });
}

export async function band($: any, surface: "terminal" | "desktop", columns = 200) {
  const now = fake.now;
  const below = fake.below ? elements.Text({ children: fake.below }) : elements.Box({ children: [] });
  const tree = renderStrip({ surface, columns, now, agents: testAgents.list, below }, { elements });
  const ui = treeUi(tree);
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
  return { ui, texts, tree };
}

// The hover cards drawn inside the pills, as element descriptions.
export async function cardNodes(ui: any): Promise<any[]> {
  const pills = ((await ui.findAll({ type: "Box" })) as any[]).filter((b) => b.key);
  return pills.flatMap((p) => ((p.children ?? []) as any[]).filter((c) => c && typeof c === "object" && c.props?.position === "absolute"));
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

// One main-loop request answered by the stubbed engine (`engineStep` queues usages, `engine.step` answers anything).
export async function stepWith($: any, { model = "claude-opus-5-5", effort }: { model?: string; effort?: unknown } = {}) {
  const at = fake.now;
  const result = await engine.step?.();
  noteStep({ model, effort }, result, at);
  return result;
}
export const step = ($: any, _usage: unknown, model = "claude-opus-5-5") => stepWith($, { model });

export function engineStep(_on: any, usages: Record<string, unknown>[]) {
  let call = 0;
  engine.step = () => ({ turnId: "t", index: 0, answer: "", toolUses: [], stopReason: "end_turn", usage: usages[Math.min(call++, usages.length - 1)] });
}

export const HIT = { model: "claude-opus-5-5", input_tokens: 300, cache_read_input_tokens: 98_000, cache_creation_input_tokens: 1_700, output_tokens: 500 };
