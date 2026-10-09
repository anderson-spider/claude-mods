// The last-turn receipt: duration, agents spawned, edits, errors and the cost of the turn. New for
// pantheon's strip. The counters are per-turn state, reset when a main-loop turn starts and read
// when it completes; the entry module feeds them from its own handlers, which stay pass-through.

import { contextData } from "./context";

export type Receipt = { ms: number; agents: number; edits: number; errors: number; usd: number | null; ctx: number };

/** Tools whose successful call counts as an edit. */
export const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

export const freshTurn = () => ({
  /** Session cost (US dollars) as the host's ledger last reported it; null without a ledger. */
  usd: null as number | null,
  /** The cost and context size when the running turn started. */
  startUsd: null as number | null,
  startTokens: 0,
  agents: 0,
  edits: 0,
  errors: 0,
  /** The finished turn, or null before the first one. */
  last: null as Receipt | null,
});
export const turnData = freshTurn();

const tokensNow = () => (contextData.readings.length > 0 ? contextData.readings[contextData.readings.length - 1].tokens : 0);

export function noteCost(usd: number | null | undefined) {
  if (typeof usd === "number" && Number.isFinite(usd)) turnData.usd = usd;
}

/** A main-loop turn starts: the counters begin again. */
export function noteTurnStart() {
  turnData.startUsd = turnData.usd;
  turnData.startTokens = tokensNow();
  turnData.agents = turnData.edits = turnData.errors = 0;
}

export function noteSpawn() {
  turnData.agents++;
}

/** A main-loop tool call came back: `isDenied` for a refusal, `isError` for a failed tool. */
export function noteTool(tool: string, { isError, isDenied }: { isError?: boolean; isDenied?: boolean }) {
  if (isDenied) return;
  if (isError) turnData.errors++;
  else if (EDIT_TOOLS.includes(tool)) turnData.edits++;
}

/** A main-loop turn completes: the receipt is what the counters and the ledger say now. */
export function noteTurnEnd({ durationMs, reason }: { durationMs: number; reason?: string }) {
  const errors = turnData.errors + (reason === "error" ? 1 : 0);
  const usd = turnData.usd !== null && turnData.startUsd !== null ? Math.max(0, turnData.usd - turnData.startUsd) : null;
  turnData.last = { ms: durationMs, agents: turnData.agents, edits: turnData.edits, errors, usd, ctx: Math.max(0, tokensNow() - turnData.startTokens) };
}
