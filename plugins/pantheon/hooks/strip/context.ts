// Adapted from hud (Apache-2.0), built on Token Weather Usage; see NOTICE and LICENSE-APACHE.

// How many context readings are kept (the latest one is what the line shows).
export const HISTORY = 12;

// Context readings: { tokens, window, percent }, oldest first.
export const freshContext = (): { readings: { tokens: number; window: number; percent: number }[] } => ({ readings: [] });
export const contextData = freshContext();

// ---------- Context readings ----------

export function pushReading(context?: { tokens?: number | null; window?: number; percent?: number | null } | null) {
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
