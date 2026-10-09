// Adapted from hud (Apache-2.0), built on Token Weather Usage; see NOTICE and LICENSE-APACHE.
import { contextData, freshContext, pushReading } from "./context";
import { limitData, freshLimits, paceStartOf } from "./limits";
import { cacheData, freshCache, isOn, recordRequest, cacheState, cacheText } from "./cache";
import { infoData, freshInfo } from "./info";
import { TURNS_PREFIX, restoreTurns, saveTurns, shareLimits, adoptShared } from "./history";
import { refreshInfo } from "./info-refresh";
import { recordPace } from "./pace";
import { noteCost, noteSpawn, noteTool, noteTurnEnd, noteTurnStart, freshTurn, turnData } from "./receipt";

// The updaters the entry module calls from its hooks, the way hud.mjs did. Host access is
// injected through `StripHost`: closures built in each hook, because `$` cannot be stored.
// The environment variables are read in register.tsx (names stay literal there) and arrive as
// `CacheEnvValues`.

export type StripHost = {
  now: () => Promise<number>;
  sessionId: () => Promise<string>;
  cwd: () => Promise<string>;
  model: () => Promise<string>;
  run: (argv: string[], options: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string }>;
  usage: () => Promise<{ context?: any; rateLimits: any[]; cost?: { usd: number } }>;
  storeKeys: () => Promise<string[]>;
  storeGet: (key: string) => Promise<any>;
  storeSet: (key: string, value: unknown) => Promise<unknown>;
  storeDelete: (key: string) => Promise<unknown>;
};
export type CacheEnvValues = { off: string; force5m: string; ttl: string; enable1h: string };

// Session-bound keys: `turnsKey` names this session's stored readings.
const stripData = { turnsKey: "" };

export function configureStrip(options?: { paceStart?: unknown }) {
  limitData.paceStart = paceStartOf(options?.paceStart);
}

/** The environment switches, from the four raw values register.tsx read. */
export function cacheEnvFrom(v: CacheEnvValues) {
  return { off: isOn(v.off), force5m: isOn(v.force5m), ttl: v.ttl, enable1h: isOn(v.enable1h) };
}

export function resetStrip() {
  Object.assign(contextData, freshContext());
  limitData.reading = freshLimits();
  Object.assign(cacheData, freshCache());
  Object.assign(infoData, freshInfo());
  limitData.history = {};
  Object.assign(turnData, freshTurn());
  stripData.turnsKey = "";
}

const storeOf = (host: StripHost) => ({
  now: host.now,
  keys: host.storeKeys,
  get: host.storeGet,
  set: host.storeSet,
  remove: host.storeDelete,
});
const turnsKey = () => stripData.turnsKey;

export function refreshStripInfo(host: StripHost): Promise<boolean> {
  return refreshInfo({ cwd: host.cwd, run: host.run, model: host.model });
}

/** session.start: fresh state, git/model readings, this session's stored readings, shared limits. */
export async function startStrip(host: StripHost, env: CacheEnvValues) {
  resetStrip();
  await refreshStripInfo(host);
  cacheData.env = cacheEnvFrom(env);
  stripData.turnsKey = TURNS_PREFIX + (await host.sessionId());
  await restoreTurns(storeOf(host), turnsKey);
  const usage = await host.usage();
  pushReading(usage.context);
  noteCost(usage.cost?.usd);
  // The shared reading wins on start or reload; the local one is published only when none exists.
  await adoptShared(host.storeGet);
  if (limitData.reading.list.length === 0 && usage.rateLimits.length > 0) await shareLimits(storeOf(host), usage.rateLimits);
  recordPaces();
}

/**
 * Notes the current windows' use for the burn rate, at the time of the reading itself: a reading
 * adopted from another session is as old as it is, never stamped with the moment it was taken up.
 */
function recordPaces() {
  const at = limitData.reading.at;
  for (const l of limitData.reading.list) if (Number.isFinite(l.percentUsed)) recordPace(limitData.history, l.kind, at, l.percentUsed, l.resetsAt);
}

/** The minute tick: another session may have measured something newer. */
export function adoptSharedLimits(host: StripHost) {
  return adoptShared(host.storeGet);
}

/**
 * The 10 s tick: true when the strip must redraw (cache countdown text, git or model changed).
 * `agentsChanged` is the caller's own check of the agents list.
 */
export async function tickStrip(host: StripHost, agentsChanged = false): Promise<boolean> {
  const key = cacheText(cacheState(await host.now()));
  const infoChanged = await refreshStripInfo(host);
  if (key !== cacheData.key || agentsChanged || infoChanged) {
    cacheData.key = key;
    return true;
  }
  return false;
}

/**
 * A main-loop request answered (not a subagent's): call with the turn.step input, the result
 * and the instant read before `next`. Returns true when the strip should redraw.
 */
export function noteStep(e: { model?: string; effort?: unknown }, result: { usage?: any } | undefined, at: number): boolean {
  infoData.current.model = e.model || infoData.current.model;
  infoData.current.effort = e.effort === undefined ? "" : String(e.effort);
  if (!result?.usage) return false;
  infoData.current.speed = result.usage.speed === "fast" ? "fast" : "";
  recordRequest(at, result.usage, e.model);
  return true;
}

/** turn.complete of the main conversation: one context reading, saved. */
export async function noteTurnComplete(host: StripHost, e: { durationMs: number; reason?: string }) {
  if (!stripData.turnsKey) return;
  const usage = await host.usage();
  pushReading(usage.context);
  noteCost(usage.cost?.usd);
  noteTurnEnd(e);
  await saveTurns(storeOf(host), turnsKey);
}

/** session.compact of the main conversation: the context drops now; the next request writes a new cache. */
export async function noteCompact(host: StripHost, e: { agentId?: string; trigger?: string }, result: any) {
  if (!stripData.turnsKey) return false;
  if (e.agentId || e.trigger === "precompute" || !result || typeof result.skip === "string") return false;
  const last = contextData.readings[contextData.readings.length - 1];
  if (Number.isFinite(result.tokensAfter) && result.tokensAfter > 0 && last?.window > 0) {
    pushReading({ tokens: result.tokensAfter, window: last.window });
  } else {
    pushReading((await host.usage()).context);
  }
  cacheData.compacted = true;
  await saveTurns(storeOf(host), turnsKey);
  return true;
}

/** session.measure: publishes a new limits reading. */
export async function noteMeasure(host: StripHost, e: { changed: string[]; rateLimits: any[]; cost?: { usd: number } }) {
  if (e.cost) noteCost(e.cost.usd);
  if (e.changed.includes("rateLimits") && e.rateLimits.length > 0) {
    await shareLimits(storeOf(host), e.rateLimits);
    recordPaces();
  }
}

/** A main-loop turn starts: the receipt counters begin again. */
export function noteStripTurnStart() {
  noteTurnStart();
}

/** The main loop spawned a subagent. */
export function noteStripSpawn() {
  noteSpawn();
}

/** A main-loop tool call came back (`result` as `next(e)` resolved it). */
export function noteStripTool(tool: string, result: { isError?: boolean; deny?: string } | undefined) {
  noteTool(tool, { isError: result?.isError === true, isDenied: typeof result?.deny === "string" });
}

/** session.end (a real end): nothing to persist; kept so the entry has one place to call. */
export function endStrip() {
  stripData.turnsKey = "";
}
