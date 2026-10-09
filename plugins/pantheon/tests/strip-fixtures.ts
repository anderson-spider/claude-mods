import { boxLines } from "../hooks/strip/box";
import type { BoxInput } from "../hooks/strip/box";
import { cacheData, freshCache, recordRequest } from "../hooks/strip/cache";
import { contextData, freshContext, pushReading } from "../hooks/strip/context";
import { infoData, freshInfo } from "../hooks/strip/info";
import { limitData, freshLimits } from "../hooks/strip/limits";
import { freshTurn, turnData } from "../hooks/strip/receipt";
import type { AgentView } from "../hooks/strip/agents";

// October 2, 2026, 13:00 UTC.
export const NOW = Date.UTC(2026, 9, 2, 13, 0);
export const H = 3_600_000;
export const D = 86_400_000;

export function reset() {
  Object.assign(contextData, freshContext());
  Object.assign(cacheData, freshCache(), { env: {} });
  limitData.reading = freshLimits();
  limitData.history = {};
  limitData.paceStart = 0;
  Object.assign(infoData, freshInfo());
  Object.assign(turnData, freshTurn());
}

export const windowOf = (kind: "five_hour" | "seven_day", percentUsed: number, elapsedShare: number) => {
  const span = kind === "five_hour" ? 5 * H : 7 * D;
  return { kind, percentUsed, resetsAt: new Date(NOW + span * (1 - elapsedShare)).toISOString() };
};

/** A calm session: Opus, a repository with changes, 62k of context, a warm cache, both windows within the pace. */
export function seed(extra: { fast?: boolean; limits?: any[]; ctx?: number; usd?: number | null; last?: boolean } = {}) {
  reset();
  Object.assign(infoData.current, { model: "claude-opus-5-5", effort: "medium", dir: "claude-mods", branch: "flightdeck", worktree: false, files: 4, added: 182, removed: 37, speed: extra.fast === false ? "" : "fast" });
  pushReading({ tokens: (extra.ctx ?? 62) * 10_000, window: 1_000_000, percent: extra.ctx ?? 62 });
  limitData.reading = { at: NOW, list: extra.limits ?? [windowOf("five_hour", 40, 0.59), windowOf("seven_day", 29, 0.25)] };
  recordRequest(NOW - 5 * 60_000, { model: "claude-opus-5-5", input_tokens: 300, cache_read_input_tokens: 98_000, cache_creation_input_tokens: 1_700 }, "claude-opus-5-5");
  if (extra.usd !== null) turnData.usd = extra.usd ?? 12.4;
  if (extra.last !== false) turnData.last = { ms: 157_000, agents: 2, edits: 4, errors: 0, usd: 0.18, ctx: 6300 };
}

export const agent = (role: string, task: string, seconds: number, extra: Partial<AgentView> = {}): AgentView => ({ id: `${role}-${seconds}`, role, task, startedAt: NOW - seconds * 1000, status: "running", ...extra });

export const input = (columns: number, extra: Partial<BoxInput> = {}): BoxInput => ({ columns, now: NOW, isWorking: false, agents: [], ...extra });

/** The box as plain text lines. */
export const plain = (columns: number, extra: Partial<BoxInput> = {}): string[] => boxLines(input(columns, extra)).map(row => row.map(r => r.text).join(""));

export const elements = Object.fromEntries(["Box", "Text"].map(type => [type, (props: any) => ({ type, key: props.key, props, children: props.children, ...(type === "Text" ? { text: String(props.children) } : {}) })]));

/** Every Text of a tree with its props, in order. */
export function texts(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach(n => texts(n, out)); return out; }
  if (node.type === "Text") out.push({ text: node.text, ...node.props });
  texts(node.children, out);
  return out;
}
