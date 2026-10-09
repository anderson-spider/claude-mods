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
// clear to compact soon. Unicode symbols in the terminal (single column, no emoji, so they line up
// in every font) in the theme's colors, drawn icons in the app, each in its own tint.
const CTX_BANDS = [
  { from: 0, id: "clear", icon: "☀", term: "yellow", app: "#e0b000" },
  { from: 25, id: "cloudy", icon: "☁", term: "cyan", app: "#8ea3b8" },
  { from: 50, id: "showers", icon: "☂", term: "blue", app: "#2f68c0" },
  { from: 75, id: "storm", icon: "☇", term: "magenta", app: "#b04fc0" },
  { from: 90, id: "compact", icon: "↯", term: "red", app: "#d64545" },
];
// Turn bars: tokens added by each recent prompt; the current prompt takes the weather's tint
// (colors readable on light and dark backgrounds), earlier ones stay grey.
export const BARS = "▁▂▃▄▅▆▇█";
export const TURN_BARS = 5;
export const SPARK = { height: 14, bar: 5.5, gap: 2 };
export const PAST_BAR = "rgba(127,127,127,0.45)";
export const SPARK_COLORS = { yellow: "#e0b000", cyan: "#1ba1c4", blue: "#2f68c0", magenta: "#b04fc0", red: "#d64545" };

export const ctxBand = (share) => [...CTX_BANDS].reverse().find((b) => share >= b.from) ?? CTX_BANDS[0];

// Weather icons drawn in the app: filled, 15 px, each in its band's color. "Compact soon"
// redraws the ↯ zigzag with a thick stroke.
export const WEATHER_ICON_SIZE = 15;
const WEATHER_ICONS = {
  clear: (c) =>
    `<circle cx="12" cy="12" r="4.5" fill="${c}"/><path fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
  cloudy: (c) =>
    `<path fill="${c}" stroke="${c}" stroke-width="1.5" stroke-linejoin="round" d="M7 18.5a3.75 3.75 0 0 1-.4-7.48A5.6 5.6 0 0 1 17.2 9.6a4.45 4.45 0 0 1 .3 8.9z"/>`,
  showers: (c) =>
    `<path fill="${c}" stroke="${c}" stroke-width="1.5" stroke-linejoin="round" d="M7 14.5a3.25 3.25 0 0 1-.35-6.48A5 5 0 0 1 16.2 6.8a3.85 3.85 0 0 1 .3 7.7z"/><path fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" d="M8.5 17.5l-1 2.5M12.5 17.5l-1 2.5M16.5 17.5l-1 2.5"/>`,
  storm: (c) => `<path fill="${c}" stroke="${c}" stroke-width="1.5" stroke-linejoin="round" d="M13.5 2 5 13.5h6.5L10.5 22 19 10.5h-6.5z"/>`,
  compact: (c) =>
    `<path fill="none" stroke="${c}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" d="M14 2 7 12h8l-5 9M14.5 18.8 10 21l-.5-5"/>`,
};
// The weather and block icons share the same square view box.
export const iconSvg = (body, size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${body}</svg>`;
export const weatherSvg = (band) => iconSvg(WEATHER_ICONS[band.id](band.app), WEATHER_ICON_SIZE);

// ---------- Layout ----------

export const SEP = "|";
// The quota bar, ten cells drawn as a line, so it sits mid-row and leaves the rows around it room:
// ━ used (in the window's color within the pace, the tone's ahead of it), ╌ the slack left before
// the clock, ─ the rest, and │ between the cells where the clock stands. In the app the same
// segments are drawn as a rounded SVG rail.
export const TEXT_CELLS = 10;
export const BAR_CELLS = { used: "━", over: "━", slack: "╌", rest: "─" };
export const PACE_TICK = "│";
export const RAIL = { width: 64, height: 12, track: "rgba(127,127,127,0.22)", slack: 0.3, pace: "#8a8f98" };
const TONES = {
  calm: { svg: "#3fa66b", text: "green" },
  // The theme's "yellow" is bright yellow in the app, unreadable on the yellow pill: a deep amber.
  fast: { svg: "#d9962b", text: "#a8690a" },
  alert: { svg: "#d64545", text: "red" },
};
// A mark and the gap in points beside the percentage of a window, so the state does not rest on
// color alone: ▲ ahead of the clock (amber or red), ▼ behind it (green); on pace, inside the
// pace start, there is no mark. The cache is signaled by color only.
export const PACE_MARKS = { ahead: "▲", behind: "▼" };
// The terminal's own palette, brighter than the app's (made for tinted pills): the same three
// tones in colors that stand out on a dark terminal, and a grey track and margin for the bar.
export const TERM_TONES = { calm: "#6fcf97", fast: "#e0a030", alert: "#ff6b6b" };
export const TERM_TRACK = "#4a525c";
export const TERM_PACE = "#d6d9de";
// The color of a tone's text: the app's on a drawn gauge ("svg"), the terminal's otherwise.
export const ink = (tone, mode) => (mode === "svg" ? TONES[tone].text : TERM_TONES[tone]);
// Desktop pills: a light tint and a slightly stronger outline per block.
export const TINTS = {
  context: ["rgba(47,104,192,0.10)", "rgba(47,104,192,0.28)"],
  five_hour: ["rgba(63,166,107,0.13)", "rgba(63,166,107,0.32)"],
  seven_day: ["rgba(140,100,210,0.13)", "rgba(140,100,210,0.32)"],
  spend_limit: ["rgba(184,140,40,0.13)", "rgba(184,140,40,0.34)"],
  calm: ["rgba(27,161,196,0.11)", "rgba(27,161,196,0.30)"],
  fast: ["rgba(217,150,43,0.14)", "rgba(217,150,43,0.36)"],
  alert: ["rgba(214,69,69,0.12)", "rgba(214,69,69,0.36)"],
  model: ["rgba(204,120,92,0.12)", "rgba(204,120,92,0.34)"],
  repo: ["rgba(128,128,128,0.10)", "rgba(128,128,128,0.30)"],
  clean: ["rgba(63,166,107,0.11)", "rgba(63,166,107,0.30)"],
};
// Small outlined icons in the app, each in its pill's color (the alt text is required: a
// drawing without one is dropped). The clock before a reset time takes the pill's color too.
export const ICON_SIZE = 16;
export const SMALL_ICON = 14;
export const ICONS = {
  // The gauge is drawn around y=11.5: half a unit down centres them like the others.
  gauge: (c) =>
    `<g transform="translate(0 0.5)"><path d="M3.6 18.5a9.5 9.5 0 1 1 16.8 0" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/><path d="M12 14.5l4.3-4.6" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="14.5" r="1.7" fill="${c}"/></g>`,
  calendar: (c) =>
    `<rect x="3" y="4.5" width="18" height="17" rx="3" fill="none" stroke="${c}" stroke-width="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/><text x="12" y="19.2" font-size="8.5" font-weight="700" font-family="-apple-system,Helvetica,Arial,sans-serif" text-anchor="middle" fill="${c}">7</text>`,
  // A clock turning back: the time left before the window starts over.
  clock: (c) =>
    `<path d="M4.2 13A8 8 0 1 0 6.6 6.2" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round"/><path d="M3.4 3.6v4.2h4.2" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8v4.6l3 1.8" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round"/>`,
  bolt: (c) => `<path d="M13.2 2 4 13.6h7.2L10.4 22l9.2-11.6h-7.2z" fill="${c}" fill-opacity="0.18" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`,
  coin: (c) =>
    `<circle cx="12" cy="12" r="9.5" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-width="2"/><path d="M15 8.8c-.5-1-1.6-1.6-3-1.6-1.7 0-3 .9-3 2.2s1.3 1.8 3 2.1 3 .9 3 2.2-1.3 2.3-3 2.3c-1.4 0-2.5-.6-3.1-1.6M12 5.6v1.6M12 16.8v1.6" fill="none" stroke="${c}" stroke-width="1.9" stroke-linecap="round"/>`,
};
// Icon color per block: deeper than the pill's tint, readable on light and dark backgrounds.
export const ICON_COLORS = { five_hour: "#3a9a62", seven_day: "#8a5fd0", spend_limit: "#b8892a", calm: "#1b9cbe", fast: "#d9962b", alert: "#d64545" };
export const LIMIT_ICONS = { five_hour: "gauge", seven_day: "calendar", spend_limit: "coin" };
// Columns the terminal may cover at the end of the band.
export const RESERVED_COLUMNS = 2;
