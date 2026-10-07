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
// and the functions that take $ live at the top level in this file. It is also the only place that
// reads the settings (paceStart, minAnswerChars, suggestSkills).
// Pure code lives beside it: constants.mjs (labels, palette, icons), formatting.mjs (numbers and
// time), context.mjs (readings and charts), limits.mjs (windows), cache.mjs (requests and TTL),
// suggestions.mjs (prompts and their block), info.mjs (info state and line), drawing.mjs (usage line).
// Injected flows: suggestion-flow.mjs (fork and draft actions), history.mjs (stored readings),
// info-refresh.mjs (folder, git and model readings), render.mjs (AbovePrompt composition).
// Shared mutable groups export stable state objects; resets reuse fresh...() factories.

import { MINUTE } from "./formatting.mjs";
import { contextData, freshContext, pushReading } from "./context.mjs";
import { limitData, freshLimits, paceStartOf } from "./limits.mjs";
import { cacheData, freshCache, isOn, recordRequest, cacheState, cacheText } from "./cache.mjs";
import { suggestionData, freshSuggestions } from "./suggestions.mjs";
import { infoData, freshInfo, recordSpeed } from "./info.mjs";
import { startSuggestions as startSuggestionFlow, fillSuggestion as fillSuggestionDraft } from "./suggestion-flow.mjs";
import { TURNS_PREFIX, restoreTurns as restoreHistory, saveTurns as saveHistory, shareLimits as shareReading, adoptShared as adoptReading } from "./history.mjs";
import { refreshInfo as refreshInfoReading } from "./info-refresh.mjs";
import { renderHud } from "./render.mjs";

// Tickers and keys belong to the host integration, as do the subagents running now.
// `agentModels` keeps each subagent's last request model, by agent id, while it runs.
const freshAgents = () => ({ agents: [], agentsKey: "", agentModels: {} });
const hudData = { ticker: null, cacheTicker: null, turnsKey: null, ...freshAgents() };

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
    // A subagent's request: only its model, for the info line; the main model stays the session's.
    if (e.agentId) {
      if (e.model && hudData.agentModels[e.agentId] !== e.model) {
        hudData.agentModels[e.agentId] = e.model;
        if (hudData.agents.some((a) => a.id === e.agentId)) {
          hudData.agents = hudData.agents.map((a) => (a.id === e.agentId ? { ...a, model: e.model } : a));
          $.ui.invalidate("ui.render");
        }
      }
      return yield* next(e);
    }
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
    return renderHud(elements, e, props, below, {
      fill: (index) => fillSuggestion($, index),
      dismiss: () => showSuggestions($, freshSuggestions()),
      now: () => $.clock.now(),
      agents: () => hudData.agents,
    });
  });
}

// ---------- Next steps: host calls and draft actions ----------

function showSuggestions($, next) {
  suggestionData.current = next;
  $.ui.invalidate("ui.render");
}

// Turn over: the detached flow receives only the host actions it needs.
function startSuggestions($, e) {
  startSuggestionFlow({
    show: (next) => showSuggestions($, next),
    commands: () => $.command.list(),
    fork: (request) => $.model.fork(request),
    log: (text) => $.ui.log(text),
    suggest: (request) => $.prompt.suggest(request),
  }, e);
}

function fillSuggestion($, index) {
  fillSuggestionDraft({
    show: (next) => showSuggestions($, next),
    fill: (request) => $.prompt.fill(request),
    toast: (text) => $.ui.toast(text),
  }, index);
}

// ---------- Stored readings: host calls ----------

async function restoreTurns($) {
  return restoreHistory({
    now: () => $.clock.now(),
    keys: () => $.store.keys(),
    get: (key) => $.store.get(key),
    remove: (key) => $.store.delete(key),
  }, () => hudData.turnsKey);
}

async function saveTurns($) {
  return saveHistory({ now: () => $.clock.now(), set: (key, value) => $.store.set(key, value) }, () => hudData.turnsKey);
}

async function shareLimits($, list) {
  return shareReading({
    now: () => $.clock.now(),
    get: (key) => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
  }, list);
}

async function adoptShared($) {
  return adoptReading((key) => $.store.get(key));
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
  const running = (list ?? []).filter((a) => a && a.status === "running").map((a) => ({ id: a.id, type: a.type ?? "", description: a.description ?? "", model: hudData.agentModels[a.id] ?? "" }));
  const key = running.map((a) => a.id).join(",");
  if (key === hudData.agentsKey) return false;
  hudData.agentsKey = key;
  hudData.agents = running;
  // Agents listed as no longer running drop their model; one not listed yet may already have made a request.
  for (const a of list ?? []) if (a && a.status !== "running") delete hudData.agentModels[a.id];
  return true;
}

// ---------- Info line: host readings ----------

async function refreshInfo($) {
  return refreshInfoReading({
    cwd: () => $.session.cwd(),
    run: (argv, options) => $.process.run(argv, options),
    model: () => $.session.model(),
  });
}
