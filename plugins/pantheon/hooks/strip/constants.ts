// Adapted from hud (Apache-2.0), built on Token Weather Usage; see NOTICE and LICENSE-APACHE.
// ---------- Text ----------

// All labels are in English (en-US).
const TEXT = {
  en: {
    percent: (n) => `${n}%`,
    weather: { clear: "Clear", cloudy: "Cloudy", showers: "Showers", storm: "Storm", compact: "Compact soon" },
    labels: { five_hour: "5h", seven_day: "7d", spend_limit: "$" },
    contextAlt: (word, percent, window) => `${word} · ${percent} of ${window}`,
    turnsAlt: (n) => `Tokens added by the last ${n} prompts`,
    railAlt: (used, clock) => (clock === null ? `${used}% used` : `${used}% used, ${clock}% of the window gone`),
    day: "d",
    gaugeAlt: (label, value) => `${label}: ${value} used`,
    cache: "cache",
    expired: "expired",
    compacted: "compacted",
    missed: "missed",
    causes: { model: "model changed", lapsed: "lapsed", prefix: "start changed" },
    underMinute: "< 1m",
    hit: "hit",
    resetsAt: (time) => `Resets at ${time}`,
    resetsOn: (time) => `Resets ${time}`,
    runsOutAt: (time) => `At this pace, runs out at ${time}`,
    runsOutOn: (time) => `At this pace, runs out ${time}`,
    toRewrite: (tokens) => `${tokens} to rewrite`,
    newThread: "new thread",
    times: (n) => `x${n}`,
    atStake: (what) => `${what} at stake`,
    // The cache's tooltip in the app, one line per item.
    tips: {
      warm: (time, oneHour, observed) => `Cache warm until ${time} (${oneHour ? "1-hour" : "5-minute"} lifetime, ${observed ? "observed" : "assumed"}).`,
      lastRead: (share, tokens) => `Last message: ${share} read from the cache (${tokens}).`,
      soon: (time, tokens) => `The cache expires at ${time}. Send your next message before then, or it writes ${tokens} tokens again.`,
      expired: (tokens) => `The next message writes the whole context (${tokens}) again at full price.`,
      compact: "/compact before going on: the context written again will be smaller.",
      newThread: "A new thread avoids this rewrite; a compaction would read it all again.",
      missed: (share, cause, tokens) => `This message read only ${share} from the cache (${cause}): it wrote ${tokens} tokens again.`,
      compacted: "Compacted: the next message writes a new, smaller cache.",
    },
    icons: { five_hour: "5-hour limit", seven_day: "7-day limit", spend_limit: "Spend limit", reset: "Resets in", cache: "Prompt cache" },
    worktree: "⎇wt",
  },
};
export const T = TEXT.en;

// The context as a weather icon, as in Token Weather: five bands by the share of the window, from
// clear to compact soon. Single-column symbols (no emoji) so they line up in every font.
const CTX_BANDS = [
  { from: 0, id: "clear", icon: "☀", term: "#e5c07b" },
  { from: 25, id: "cloudy", icon: "☁", term: "#56b6c2" },
  { from: 50, id: "showers", icon: "☂", term: "#5b93e6" },
  { from: 75, id: "storm", icon: "☇", term: "#c678dd" },
  { from: 90, id: "compact", icon: "↯", term: "#ff6b6b" },
];
export const ctxBand = (share: number) => [...CTX_BANDS].reverse().find((b) => share >= b.from) ?? CTX_BANDS[0];

// The quota bar, as hud drew it: ━ used (in the window's color within the pace, the tone's ahead
// of it), ╌ the slack left before the clock, ─ the rest, and │ between the cells where the clock
// stands. A mark and the gap in points beside the percentage keep the state from resting on color
// alone: ▲ ahead of the clock (amber or red), ▼ behind it (green); on pace, no mark.
export const TEXT_CELLS = 10;
export const BAR_CELLS = { used: "━", over: "━", slack: "╌", rest: "─" };
export const PACE_TICK = "│";
export const PACE_MARKS = { ahead: "▲", behind: "▼" };
// The terminal's palette: the three tones, a grey track and the clock mark. Amber is brighter than
// hud's #a8690a, which is too dark on a dark terminal.
export const TERM_TONES = { calm: "#6fcf97", fast: "#e0a030", alert: "#ff6b6b" };
export const TERM_TRACK = "#4a525c";
export const TERM_PACE = "#d6d9de";
export const ink = (tone: "calm" | "fast" | "alert") => TERM_TONES[tone];
