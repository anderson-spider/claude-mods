import { BARS, TURN_BARS, SPARK, PAST_BAR } from "./constants";
import { short } from "./formatting";

// How many context readings are kept (the latest one is what the line shows).
export const HISTORY = 12;

// Context readings: { tokens, window, percent }, oldest first.
export const freshContext = () => ({ readings: [] });
export const contextData = freshContext();

// ---------- Context readings ----------

export function pushReading(context) {
  if (!context || !context.window) return;
  const tokens = context.tokens ?? 0;
  const percent = Math.round(context.percent ?? (tokens / context.window) * 100);
  // The start reading is 0 before the first answer: drop it as soon as a real one arrives.
  contextData.readings = contextData.readings.filter((r) => r.tokens > 0);
  // A reopened session reads the same context again: no duplicate reading, so no false empty bar.
  const last = contextData.readings[contextData.readings.length - 1];
  if (last && last.tokens === tokens && tokens > 0) return;
  contextData.readings.push({ tokens, window: context.window, percent });
  if (contextData.readings.length > HISTORY) contextData.readings = contextData.readings.slice(-HISTORY);
}

// Tokens added by each recent prompt (at most TURN_BARS), oldest first.
// A compaction lowers the context: that prompt counts as 0.
export function turnDeltas() {
  const deltas = [];
  for (let i = 1; i < contextData.readings.length; i++) deltas.push(Math.max(0, contextData.readings[i].tokens - contextData.readings[i - 1].tokens));
  return deltas.slice(-TURN_BARS);
}

// Height relative to the heaviest prompt shown: the prompt that cost the most fills the height.
function barLevels() {
  const deltas = turnDeltas();
  const top = Math.max(...deltas, 1);
  return deltas.map((d) => d / top);
}

// Terminal: one character per prompt, earlier ones grey, the current one in the weather's tint.
export function chartText(Text, color) {
  const glyphs = barLevels().map((level) => BARS[Math.round(level * (BARS.length - 1))]);
  const last = glyphs.pop();
  const parts = [];
  if (glyphs.length > 0) parts.push(Text({ key: "past", dimColor: true, children: glyphs.join("") }));
  parts.push(Text({ key: "now", color, children: last }));
  return parts;
}

// Just wide enough for n bars.
export function barsWidth(n) {
  return Math.max(1, n) * SPARK.bar + Math.max(0, n - 1) * SPARK.gap;
}

// App: rounded bars, the most recent in color; a prompt at 0 keeps a line on the floor.
export function barsSvg(color) {
  const { height, bar, gap } = SPARK;
  const levels = barLevels();
  const width = barsWidth(levels.length);
  const rects = levels.map((level, i) => {
    const h = Math.max(1, level * height);
    const fill = i === levels.length - 1 ? color : PAST_BAR;
    return `<rect x="${(i * (bar + gap)).toFixed(1)}" y="${(height - h).toFixed(1)}" width="${bar}" height="${h.toFixed(1)}" rx="1.5" fill="${fill}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rects.join("")}</svg>`;
}

export function trendWord() {
  if (contextData.readings.length < 2) return "";
  const delta = contextData.readings[contextData.readings.length - 1].tokens - contextData.readings[contextData.readings.length - 2].tokens;
  if (delta > 0) return `▲ +${short(delta)}`;
  if (delta < 0) return `▼ −${short(-delta)}`;
  return "=";
}
