// HUD: one line above the prompt, and suggested next prompts above it.
//   Terminal, blocks split by a thin rule:
//   ☁ 440k ▃▄▂▇▆ ▲ +8.4k │ 5h ██▒▒░░ 37% ▼ 3 · 2h22 │ 7d ███▓░░ 60% ▲ 2 · 2d23h │ cache 52 min │ 2 agents
//   Desktop app: the same blocks as tinted, outlined pills.
//
// Context reading: adapted from the Token Weather example,
//   Copyright 2026 Anthropic PBC, SPDX-License-Identifier: Apache-2.0 (claude-code-playground).
// 5-hour and 7-day limits: written for this mod after HolyGrail's usage-meter
//   (https://github.com/HolyGrail/claude-mods/tree/main/plugins/usage-meter), without copying its code.
// Prompt cache: written for this mod after Daniel San's prompt-cache-control
//   (https://github.com/davila7/claude-code-templates, MIT), without copying its code.
//
// The engine reads on(...) and $.noun.method(...) from the source: they stay spelled out,
// and the functions that take $ live at the top level in this file.
// Pure code lives beside it: constants.mjs (labels, palette, icons), formatting.mjs (numbers and
// time), context.mjs (readings and charts), limits.mjs (windows), cache.mjs (requests and TTL),
// suggestions.mjs (prompts and their block), info.mjs (info state and line), drawing.mjs (usage line).
// Shared mutable groups export stable state objects; resets reuse fresh...() factories.

import { MINUTE } from "./formatting.mjs";
import { HISTORY, contextData, freshContext, pushReading } from "./context.mjs";
import { limitData, freshLimits, paceStartOf, sortLimits } from "./limits.mjs";
import { cacheData, freshCache, isOn, recordRequest, cacheState, cacheText } from "./cache.mjs";
import {
  suggestionData, freshSuggestions, skillList, forkPrompt, parseSuggestions, combine, drawSuggestions,
} from "./suggestions.mjs";
import { infoData, freshInfo, recordSpeed, drawInfo } from "./info.mjs";
import { drawLine, isBlank } from "./drawing.mjs";

// Each session's readings are kept in $.store, so the bars come back after a restart.
const TURNS_PREFIX = "turns:";
const TURNS_KEEP_MS = 8 * 24 * 3_600_000;

// Limits belong to the account: the latest reading, across sessions, lives in $.store.
const SHARED_KEY = "limits";

// Tickers and keys belong to the host integration, as do the subagents running now.
const freshAgents = () => ({ agents: [], agentsKey: "" });
const hudData ={ ticker: null, cacheTicker: null, turnsKey: null, ...freshAgents() };

export function register(on, options) {
  limitData.paceStart = paceStartOf(options?.paceStart);
  suggestionData.minAnswerChars = typeof options?.minAnswerChars === "number" ? options.minAnswerChars : 80;
  suggestionData.suggestSkills = options?.suggestSkills !== false && options?.suggestSkills !== "false";

  on("session.start", async ($, e, next) => {
    hudData.ticker?.cancel();
    hudData.cacheTicker?.cancel();
    Object.assign(contextData, freshContext());
    limitData.reading = freshLimits();
    Object.assign(cacheData, freshCache());
    suggestionData.current = freshSuggestions();
    Object.assign(infoData, freshInfo());
    await refreshInfo($);
    cacheData.env = await cacheEnvOf($);
    hudData.turnsKey = TURNS_PREFIX + (await $.session.id());
    await restoreTurns($);
    const usage = await $.session.usage();
    pushReading(usage.context);
    Object.assign(hudData, freshAgents());
    await refreshAgents($);
    // On start or reload the local reading may be stale (an idle session): the shared reading
    // wins, and the local one is published only when none exists yet.
    await adoptShared($);
    if (limitData.reading.list.length === 0 && usage.rateLimits.length > 0) await shareLimits($, usage.rateLimits);
    // Every minute: elapsed time moves on, and another session may have measured something newer.
    hudData.ticker = $.clock.every(MINUTE, async () => {
      await adoptShared($);
      $.ui.invalidate("ui.render");
    });
    // The cache countdown: a redraw only when its text changes.
    // and the agents running, which start and end between turns.
    hudData.cacheTicker = $.clock.every(10_000, async () => {
      const key = cacheText(cacheState(await $.clock.now()));
      const agentsChanged = await refreshAgents($);
      const infoChanged = await refreshInfo($);
      if (key !== cacheData.key || agentsChanged || infoChanged) {
        cacheData.key = key;
        $.ui.invalidate("ui.render");
      }
    });
    $.ui.invalidate("ui.render");
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    // A real end (exit, or process stopped); /clear, /resume and disconnect keep the tickers.
    if (e.reason === "prompt_input_exit" || e.reason === "other") {
      hudData.ticker?.cancel();
      hudData.cacheTicker?.cancel();
    }
    return next(e);
  });

  // Each main-loop request: how much of its prompt the cache served (subagents have their own).
  on("turn.step", async function* ($, e, next) {
    if (e.agentId) return yield* next(e);
    const at = await $.clock.now();
    const result = yield* next(e);
    infoData.current.model = e.model || infoData.current.model;
    infoData.current.effort = e.effort === undefined ? "" : String(e.effort);
    if (result?.usage) {
      recordSpeed(result.usage.output_tokens, (await $.clock.now()) - at);
      recordRequest(at, result.usage, e.model);
      // The request may have started an agent.
      await refreshAgents($);
      $.ui.invalidate("ui.render");
    }
    return result;
  });

  // A new turn of the conversation hides what was offered; a subagent's turn does not.
  on("turn.start", async ($, e, next) => {
    if (!e.agentId && suggestionData.current.kind !== "hidden") showSuggestions($, freshSuggestions());
    return next(e);
  });

  // One context reading after each main turn (not subagents' turns).
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    // A subagent's turn: it may have just finished.
    if (e.agentId) {
      if (await refreshAgents($)) $.ui.invalidate("ui.render");
      return result;
    }
    startSuggestions($, e);
    try {
      const usage = await $.session.usage();
      pushReading(usage.context);
      await saveTurns($);
      $.ui.invalidate("ui.render");
    } catch {
      // No reading this turn: the line keeps the previous one.
    }
    return result;
  });

  // A compaction of the main conversation: the context drops now, not at the end of the next
  // prompt. Its size comes from the compaction's result (or, missing, the live figures); the
  // next request writes a new cache, which is neither expired nor a miss.
  on("session.compact", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId || e.trigger === "precompute" || !result || typeof result.skip === "string") return result;
    try {
      const last = contextData.readings[contextData.readings.length - 1];
      if (Number.isFinite(result.tokensAfter) && result.tokensAfter > 0 && last?.window > 0) {
        pushReading({ tokens: result.tokensAfter, window: last.window });
      } else {
        pushReading((await $.session.usage()).context);
      }
      cacheData.compacted = true;
      await saveTurns($);
      $.ui.invalidate("ui.render");
    } catch {
      // No reading: the line catches up at the end of the next prompt.
    }
    return result;
  });

  on("session.measure", async ($, e, next) => {
    if (e.changed.includes("rateLimits") && e.rateLimits.length > 0) await shareLimits($, e.rateLimits);
    $.ui.invalidate("ui.render");
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const props = e.props ?? e;
    const below = await next(e);
    if (props.hasSurvey) return below;
    const elements = $.ui.resolve(e);
    // Top to bottom: what mods placed after us draw, the suggestions, and the usage line last, so it
    // stays next to the prompt however the block above comes and goes. An empty drawing adds no blank line.
    const parts = [];
    if (!isBlank(below)) parts.push(below);
    const block = e.surface === "terminal" && !props.isWorking
      ? drawSuggestions(elements, {
          pick: (index) => togglePick($, index),
          write: () => writePicks($),
          dismiss: () => showSuggestions($, freshSuggestions()),
        })
      : null;
    if (block) parts.push(block);
    const infoLine = e.surface === "terminal" ? drawInfo(elements, props.bodyColumns ?? 80) : null;
    const hasLine = contextData.readings.length > 0 || limitData.reading.list.length > 0;
    // A blank line keeps the suggestions apart from what follows them.
    if (block && (infoLine || hasLine)) parts.push(elements.Box({ key: "gap-usage", marginTop: 1, children: [] }));
    if (infoLine) parts.push(infoLine);
    if (hasLine) {
      parts.push(drawLine(elements, e.surface, props.bodyColumns ?? 80, await $.clock.now(), hudData.agents));
    }
    if (parts.length === 0) return below;
    return parts.length === 1 ? parts[0] : elements.Box({ flexDirection: "column", children: parts });
  });
}

// ---------- Next steps: host calls and draft actions ----------

function showSuggestions($, next) {
  suggestionData.current = next;
  $.ui.invalidate("ui.render");
}

// Turn over: ask the fork, detached, so the turn's completion never waits on it.
function startSuggestions($, e) {
  if (e.reason !== "answer" || (e.answer ?? "").trim().length < suggestionData.minAnswerChars) return;
  const turnId = e.turnId;
  showSuggestions($, { kind: "loading", turnId });
  void (async () => {
    let items = [];
    try {
      // Without the list the fork still suggests; slash prompts go unchecked.
      const commands = await $.command.list().catch(() => null);
      const known = commands === null ? null : new Set(commands.map((command) => command.name));
      const skills = suggestionData.suggestSkills && commands !== null ? skillList(commands) : "";
      const reply = await $.model.fork({ prompt: forkPrompt(skills) });
      items = reply.isAnswered ? parseSuggestions(reply.text, known) : [];
    } catch (error) {
      $.ui.log(`fork failed: ${String(error)}`);
    }
    // A newer turn started (or another completed) while we waited: drop ours.
    if (suggestionData.current.kind !== "loading" || suggestionData.current.turnId !== turnId) return;
    showSuggestions($, items.length === 0 ? freshSuggestions() : { kind: "offer", items, picked: [] });
    if (items[0]) void $.prompt.suggest({ text: items[0].prompt }).catch(() => undefined);
  })();
}

// Picks an item, or drops it from the picks when it is already there. A press from an older, longer
// offer names an item the current one does not have: ignored.
function togglePick($, index) {
  if (suggestionData.current.kind !== "offer") return;
  const { items, picked } = suggestionData.current;
  if (!(index >= 0 && index < items.length)) return;
  showSuggestions($, { kind: "offer", items, picked: picked.includes(index) ? picked.filter((i) => i !== index) : [...picked, index] });
}

// Writes the picks to the prompt box as a draft and hides the block; the person edits and sends it.
function writePicks($) {
  if (suggestionData.current.kind !== "offer") return;
  const text = combine(suggestionData.current.items, suggestionData.current.picked);
  showSuggestions($, freshSuggestions());
  if (text === "") return;
  $.prompt.fill({ text }).then(
    (r) => r.isFilled || $.ui.toast("could not fill the prompt box"),
    (error) => $.ui.toast(`could not fill: ${String(error)}`),
  );
}
// ---------- Turns: readings kept per session ----------

// Restores this session's readings and cache, and deletes sessions idle for more than 8 days.
async function restoreTurns($) {
  const now = await $.clock.now();
  try {
    for (const key of await $.store.keys()) {
      if (!key.startsWith(TURNS_PREFIX)) continue;
      const saved = await $.store.get(key);
      if (key === hudData.turnsKey && saved && Array.isArray(saved.readings)) {
        contextData.readings = saved.readings.filter((r) => r && r.window > 0).slice(-HISTORY);
        if (saved.cache && Number.isFinite(saved.cache.at)) cacheData.request = saved.cache;
        cacheData.compacted = saved.compacted === true;
        if (saved.seenTtl === "5m" || saved.seenTtl === "1h") cacheData.seenTtl = saved.seenTtl;
      } else if (!saved || !(now - saved.at < TURNS_KEEP_MS)) await $.store.delete(key);
    }
  } catch {
    // Unreadable store: the line starts from scratch.
  }
}

async function saveTurns($) {
  if (!hudData.turnsKey) return;
  try {
    await $.store.set(hudData.turnsKey, {
      at: await $.clock.now(),
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
async function shareLimits($, list) {
  const at = await $.clock.now();
  limitData.reading = { at, list: sortLimits(list) };
  let stored = null;
  try {
    stored = await $.store.get(SHARED_KEY);
  } catch {
    stored = null;
  }
  if (!stored || !(stored.at > at)) await $.store.set(SHARED_KEY, limitData.reading);
}

// Takes another session's reading when it is newer than ours.
async function adoptShared($) {
  try {
    const stored = await $.store.get(SHARED_KEY);
    if (stored && Array.isArray(stored.list) && stored.at > limitData.reading.at) limitData.reading = { at: stored.at, list: sortLimits(stored.list) };
  } catch {
    // Unreadable store: keep the local reading.
  }
}

// ---------- Prompt cache: requests and lifetime ----------

// Names stay literal: the engine lists the variables a module reads.
async function cacheEnvOf($) {
  const read = async (get) => {
    try {
      return (await get()) || "";
    } catch {
      return "";
    }
  };
  return {
    off: isOn(await read(() => $.env.get("DISABLE_PROMPT_CACHING"))),
    force5m: isOn(await read(() => $.env.get("FORCE_PROMPT_CACHING_5M"))),
    ttl: await read(() => $.env.get("CLAUDE_CODE_PROMPT_CACHE_TTL")),
    enable1h: isOn(await read(() => $.env.get("ENABLE_PROMPT_CACHING_1H"))),
  };
}

// ---------- Agents ----------

// Reads the subagents running now; true when the list changed.
async function refreshAgents($) {
  let list = [];
  try {
    list = await $.agent.list();
  } catch {
    return false;
  }
  const running = (list ?? []).filter((a) => a && a.status === "running").map((a) => ({ id: a.id, type: a.type ?? "", description: a.description ?? "" }));
  const key = running.map((a) => a.id).join(",");
  if (key === hudData.agentsKey) return false;
  hudData.agentsKey = key;
  hudData.agents = running;
  return true;
}

// ---------- Info line: host readings ----------

// Unity's YAML assets swell the line counts and slow the diff: left out of them.
const DIFF_EXCLUDES = ["*.unity", "*.prefab", "*.asset", "*.meta", "*.mat", "*.anim", "*.controller", "*.physicMaterial", "*.lighting"].map((g) => `:(exclude)${g}`);

// The folder, its branch, the files changed and the model (a /model switch shows within 10 s); true when
// something changed.
async function refreshInfo($) {
  const before = JSON.stringify(infoData.current);
  try {
    const cwd = await $.session.cwd();
    infoData.current.dir = cwd.split("/").filter(Boolean).pop() ?? "";
    const git = await $.process.run(["git", "--no-optional-locks", "branch", "--show-current"], { cwd, timeoutMs: 3000 });
    infoData.current.branch = git.exitCode === 0 ? git.stdout.trim() : "";
    infoData.current.files = infoData.current.added = infoData.current.removed = 0;
    if (git.exitCode === 0) {
      const status = await $.process.run(["git", "--no-optional-locks", "status", "--porcelain"], { cwd, timeoutMs: 3000 });
      infoData.current.files = status.exitCode === 0 ? status.stdout.split("\n").filter(Boolean).length : 0;
      if (infoData.current.files > 0) {
        const diff = await $.process.run(["git", "--no-optional-locks", "diff", "HEAD", "--numstat", "--", ".", ...DIFF_EXCLUDES], { cwd, timeoutMs: 3000 });
        for (const line of diff.exitCode === 0 ? diff.stdout.split("\n") : []) {
          const [a, r] = line.split("\t");
          infoData.current.added += Number(a) || 0;
          infoData.current.removed += Number(r) || 0;
        }
      }
    }
    // The host has no effort getter, so a switch with /model shows no effort until the next request.
    const model = await $.session.model();
    if (model !== infoData.sessionModel) {
      if (infoData.sessionModel !== "") infoData.current.effort = "";
      infoData.sessionModel = model;
      infoData.current.model = model;
    }
  } catch {
    // No folder or git here: the line shows what it has.
  }
  return JSON.stringify(infoData.current) !== before;
}
