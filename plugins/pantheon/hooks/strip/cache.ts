import { T } from "./constants";
import { MINUTE, HOUR, duration, clockTime, short } from "./formatting";
import { contextData } from "./context";
import { limitData } from "./limits";

// ---------- Prompt cache ----------

// The cache keeps the start of the conversation for 5 minutes, or 1 hour; each request that
// reads it starts the time again, counted from the request's start. Once it lapses, the next
// message writes the whole context again. Mods get the token counts, not the lifetime: it is
// inferred (Claude Code's rules, then what the traffic shows).
const TTL = { "5m": 5 * MINUTE, "1h": HOUR };
// Yellow under a sixth of the lifetime left: 10 minutes of 1 hour, 50 seconds of 5 minutes.
const CACHE_SOON_SHARE = 1 / 6;
// The lifetime beside a warm cache, so the rule behind the countdown is in sight.
// Beside the time, for the short lifetime only: what writing the cache again costs against the
// input price, x1.25 for 5 minutes (Anthropic's cache write price as a multiple of the input
// price). The usual 1 hour (x2) goes unsaid.
const ttlLabelOf = (ttl) => (ttl === TTL["1h"] ? "" : `5m TTL · ${T.times(1.25)}`);
// From this context size, an expired cache suggests /compact before going on.
const COMPACT_AT = 100_000;
// From this one, a new thread instead: after a pause the next message writes the whole context
// again at full price; a new thread avoids that rewrite, a compaction would read it all again.
const LARGE_CONTEXT = 300_000;
// A request that read less than half its prompt from the cache, and wrote more than this, missed.
const MISS_SHARE = 50;
const MISS_WRITE = 1_000;

export const freshCache = () => ({
  // Last main-loop request: { at, model, read, write, fresh, cause }.
  request: null,
  // True from a compaction until its next request: the cache it writes is new, not a miss.
  compacted: false,
  // Lifetime seen in the traffic ("5m" | "1h"), which beats the rules.
  seenTtl: null,
  // Last countdown text: the ticker redraws only when it changes.
  key: "",
});
// Environment switches read at session start, after the request state is reset.
export const cacheData: any = { ...freshCache(), env: {} };

export function isOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function promptOf(r) {
  return (r.read ?? 0) + (r.write ?? 0) + (r.fresh ?? 0);
}

function hitOf(r) {
  const total = promptOf(r);
  return total > 0 ? Math.round(((r.read ?? 0) / total) * 100) : 0;
}

// Notes a main-loop request, names the cause when it missed the cache, learns the lifetime. The model comes from the usage, else the request.
export function recordRequest(at, usage, model) {
  const cur = {
    at,
    model: usage.model || model || "",
    read: usage.cache_read_input_tokens ?? 0,
    write: usage.cache_creation_input_tokens ?? 0,
    fresh: usage.input_tokens ?? 0,
    cause: null,
  };
  const prev = cacheData.request;
  const afterCompact = cacheData.compacted;
  cacheData.compacted = false;
  // After a compaction the request writes a new cache: read nothing, yet nothing missed.
  if (prev && !afterCompact) {
    const gap = at - prev.at;
    const missed = hitOf(cur) < MISS_SHARE && cur.write > MISS_WRITE;
    // A hit more than 5 minutes after the previous request proves the 1-hour lifetime;
    // a miss within the hour, same model, prompt not shrunk, says 5 minutes.
    if (!missed && cur.read > 0 && gap > TTL["5m"]) cacheData.seenTtl = "1h";
    else if (missed && gap > TTL["5m"] && gap < TTL["1h"] && cur.model === prev.model && promptOf(cur) >= promptOf(prev)) cacheData.seenTtl = "5m";
    if (missed) cur.cause = cur.model !== prev.model ? "model" : gap >= ttlMs() ? "lapsed" : "prefix";
  }
  cacheData.request = cur;
}

// Claude Code's rules for the main conversation, after what the traffic showed.
function ttlMs() {
  if (cacheData.seenTtl) return TTL[cacheData.seenTtl];
  if (cacheData.env.force5m) return TTL["5m"];
  if (cacheData.env.ttl === "5m" || cacheData.env.ttl === "1h") return TTL[cacheData.env.ttl];
  if (cacheData.env.enable1h) return TTL["1h"];
  // A Claude subscription within its plan usage gets 1 hour; usage credits or an API key, 5 minutes.
  const plan = limitData.reading.list.filter((l) => l.kind === "five_hour" || l.kind === "seven_day");
  return plan.length > 0 && plan.every((l) => l.percentUsed < 100) ? TTL["1h"] : TTL["5m"];
}

// What the two cache blocks show, or null when caching is off:
// - time: { tone, value, detail, urgent, stake, advice, ttlLabel, tip }, the time left. detail
//   follows the value (in yellow when urgent), stake comes after it, dim; advice is for the
//   terminal only (the app puts it in tip, the pill's hover card).
// - hit: { tone, value, detail, tip }, the share of the last message read from the cache, with
//   the cause when it missed; null before the first request, after a compaction and once expired.
export function cacheState(now) {
  if (cacheData.env.off) return null;
  if (cacheData.compacted) return { time: { tone: "none", value: T.compacted, detail: "", tip: T.tips.compacted }, hit: null };
  if (!cacheData.request) return { time: { tone: "none", value: "—", detail: "" }, hit: null };
  const left = cacheData.request.at + ttlMs() - now;
  const tokens = contextData.readings.length > 0 ? contextData.readings[contextData.readings.length - 1].tokens : promptOf(cacheData.request);
  const ttl = ttlMs();
  const ttlLabel = ttlLabelOf(ttl);
  // Expired: say what the next message writes again, and the way out: from 300k a new thread
  // (it avoids rewriting the whole context at full price), from 100k /compact. In the app the
  // way out goes to the hover card; the terminal, without one, keeps it on the line.
  if (left <= 0) {
    const rewrite = T.toRewrite(short(tokens));
    const detail = tokens < COMPACT_AT ? "" : rewrite;
    const advice = tokens >= LARGE_CONTEXT ? T.newThread : tokens >= COMPACT_AT ? "/compact" : "";
    const tip = [T.tips.expired(short(tokens))];
    if (tokens >= LARGE_CONTEXT) tip.push(T.tips.newThread);
    else if (tokens >= COMPACT_AT) tip.push(T.tips.compact);
    return { time: { tone: "alert", value: T.expired, detail, advice, ttlLabel, tip: tip.join("\n") }, hit: null };
  }
  const share = hitOf(cacheData.request);
  // A miss: the cache was written again. A cache just rebuilt after a compaction read nothing,
  // yet nothing missed.
  const cause = cacheData.request.cause ? T.causes[cacheData.request.cause] : "";
  const hit = cause
    ? { tone: "fast", value: T.percent(share), detail: `${T.missed} · ${cause}`, tip: T.tips.missed(T.percent(share), cause, short(cacheData.request.write ?? 0)) }
    : { tone: "calm", value: T.percent(share), detail: "", tip: T.tips.lastRead(T.percent(share), short(cacheData.request.read ?? 0)) };
  const value = left < MINUTE ? T.underMinute : duration(left);
  const expiry = clockTime(cacheData.request.at + ttl);
  // Under a sixth of the lifetime: what letting it lapse would write again.
  if (left < ttl * CACHE_SOON_SHARE) {
    return { time: { tone: "fast", value, detail: "", urgent: true, ttlLabel, stake: T.atStake(short(tokens)), tip: T.tips.soon(expiry, short(tokens)) }, hit };
  }
  return { time: { tone: "calm", value, detail: "", urgent: false, ttlLabel, tip: T.tips.warm(expiry, ttl === TTL["1h"], cacheData.seenTtl !== null) }, hit };
}

// The cache blocks as the terminal writes them: "cache 8m · 289k at stake | hit 97%".
// `compact` drops the lifetime: what a narrow line gives up first.
export function cacheText(state, compact = false) {
  if (!state) return "";
  const time = [`${T.cache} ${state.time.value}`, cacheDetails(state.time, compact)].filter(Boolean).join(" · ");
  return state.hit ? `${time} | ${hitText(state.hit)}` : time;
}

// "hit 97%", "hit 4% · missed · model changed".
export function hitText(hit) {
  return [`${T.hit} ${hit.value}`, hit.detail].filter(Boolean).join(" · ");
}

// The countdown's width and drawing use the same detail, lifetime, stake and advice, in that order.
export function cacheDetails(time, compact = false, detail = time.detail, advice = time.advice) {
  return [detail, ...(compact ? [] : [time.ttlLabel]), time.stake, advice].filter(Boolean).join(" · ");
}
