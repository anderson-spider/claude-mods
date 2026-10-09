// Adapted from hud (Apache-2.0), built on Token Weather Usage; see NOTICE and LICENSE-APACHE.
import { isBlank } from "./blank";
import { drawBox } from "./box";
import type { AgentView } from "./agents";

export type StripInput = {
  surface: string;
  /** Columns the body may use (the AbovePrompt props' bodyColumns). */
  columns: number;
  /** The clock, read by the caller. */
  now: number;
  /** Whether the main session is working (the AbovePrompt props' isWorking). */
  isWorking?: boolean;
  agents: AgentView[];
  /** What mods beneath this one drew under the strip (`await next(e)`). */
  below?: unknown;
};
export type StripDeps = { elements: any };

// Top to bottom: what mods placed after us draw, then the box (session, 5h, 7d, last turn or the
// agents running), which stays next to the prompt. Returns `below` untouched when the strip has
// nothing to show.
export function renderStrip(input: StripInput, deps: StripDeps): any {
  const { elements } = deps;
  const { columns, now, agents, below } = input;
  const parts: any[] = [];
  if (!isBlank(below)) parts.push(below);
  const box = drawBox(elements, { columns, now, isWorking: input.isWorking === true, agents, surface: input.surface });
  if (box) parts.push(box);
  if (parts.length === 0) return below;
  return parts.length === 1 ? parts[0] : elements.Box({ flexDirection: "column", children: parts });
}
