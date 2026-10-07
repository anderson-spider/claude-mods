import { HISTORY, contextData } from "./context.mjs";
import { cacheData } from "./cache.mjs";
import { limitData, sortLimits } from "./limits.mjs";

// Each session's readings are kept in the store, so the bars come back after a restart.
export const TURNS_PREFIX = "turns:";
const TURNS_KEEP_MS = 8 * 24 * 3_600_000;

// Limits belong to the account: the latest reading, across sessions, lives in the store.
const SHARED_KEY = "limits";

// ---------- Turns: readings kept per session ----------

// Restores this session's readings and cache, and deletes sessions idle for more than 8 days.
export async function restoreTurns({ now: clockNow, keys, get, remove }, turnsKey) {
  const now = await clockNow();
  try {
    for (const key of await keys()) {
      if (!key.startsWith(TURNS_PREFIX)) continue;
      const saved = await get(key);
      if (key === turnsKey() && saved && Array.isArray(saved.readings)) {
        contextData.readings = saved.readings.filter((r) => r && r.window > 0).slice(-HISTORY);
        if (saved.cache && Number.isFinite(saved.cache.at)) cacheData.request = saved.cache;
        cacheData.compacted = saved.compacted === true;
        if (saved.seenTtl === "5m" || saved.seenTtl === "1h") cacheData.seenTtl = saved.seenTtl;
      } else if (!saved || !(now - saved.at < TURNS_KEEP_MS)) await remove(key);
    }
  } catch {
    // Unreadable store: the line starts from scratch.
  }
}

export async function saveTurns({ now, set }, turnsKey) {
  if (!turnsKey()) return;
  try {
    await set(turnsKey(), {
      at: await now(),
      readings: contextData.readings,
      cache: cacheData.request,
      compacted: cacheData.compacted,
      seenTtl: cacheData.seenTtl,
    });
  } catch {
    // Not saved this turn: the bars come back on the next one.
  }
}

// ---------- Limits: shared reading ----------

// Keeps this session's reading and publishes it if it is the most recent known.
export async function shareLimits({ now, get, set }, list) {
  const at = await now();
  limitData.reading = { at, list: sortLimits(list) };
  let stored = null;
  try {
    stored = await get(SHARED_KEY);
  } catch {
    stored = null;
  }
  if (!stored || !(stored.at > at)) await set(SHARED_KEY, limitData.reading);
}

// Takes another session's reading when it is newer than ours.
export async function adoptShared(get) {
  try {
    const stored = await get(SHARED_KEY);
    if (stored && Array.isArray(stored.list) && stored.at > limitData.reading.at) limitData.reading = { at: stored.at, list: sortLimits(stored.list) };
  } catch {
    // Unreadable store: keep the local reading.
  }
}
