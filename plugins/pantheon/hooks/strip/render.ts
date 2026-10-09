// Adapted from hud (Apache-2.0), built on Token Weather Usage; see NOTICE and LICENSE-APACHE.
import { contextData } from "./context";
import { limitData } from "./limits";
import { drawInfo } from "./info";
import { drawLine, isBlank } from "./drawing";
import { drawAgents, type AgentView } from "./agents";

export type StripInput = {
  surface: string;
  /** Columns the body may use (the AbovePrompt props' bodyColumns). */
  columns: number;
  /** The clock, read by the caller. */
  now: number;
  agents: AgentView[];
  /** What mods beneath this one drew under the strip (`await next(e)`). */
  below?: unknown;
};
export type StripDeps = { elements: any };

// Top to bottom: what mods placed after us draw, the agents summary (only while something runs),
// the info row, the usage row, and the limits last, so they stay next to the prompt. Returns
// `below` untouched when the strip has nothing to show.
export function renderStrip(input: StripInput, deps: StripDeps): any {
  const { elements } = deps;
  const { surface, columns, now, agents, below } = input;
  const parts: any[] = [];
  if (!isBlank(below)) parts.push(below);
  const summary = drawAgents(elements, agents, columns, now);
  if (summary) parts.push(summary);
  const infoLine = drawInfo(elements, columns, surface);
  if (infoLine) parts.push(infoLine);
  if (contextData.readings.length > 0 || limitData.reading.list.length > 0) parts.push(drawLine(elements, surface, columns, now));
  if (parts.length === 0) return below;
  return parts.length === 1 ? parts[0] : elements.Box({ flexDirection: "column", children: parts });
}
