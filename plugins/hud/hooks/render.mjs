import { contextData } from "./context.mjs";
import { limitData } from "./limits.mjs";
import { drawSuggestions } from "./suggestions.mjs";
import { drawInfo } from "./info.mjs";
import { drawLine, isBlank } from "./drawing.mjs";

export async function renderHud(elements, e, props, below, { fill, dismiss, now, agents }) {
  // Top to bottom: what mods placed after us draw, the suggestions, and the usage line last, so it
  // stays next to the prompt however the block above comes and goes. An empty drawing adds no blank line.
  const parts = [];
  if (!isBlank(below)) parts.push(below);
  const block = props.isWorking ? null : drawSuggestions(elements, { fill, dismiss });
  if (block) parts.push(block);
  const infoLine = drawInfo(elements, props.bodyColumns ?? 80, e.surface);
  const hasLine = contextData.readings.length > 0 || limitData.reading.list.length > 0;
  // A blank line keeps the suggestions apart from what follows them.
  if (block && (infoLine || hasLine)) parts.push(elements.Box({ key: "gap-usage", marginTop: 1, children: [] }));
  if (infoLine) parts.push(infoLine);
  if (hasLine) {
    parts.push(drawLine(elements, e.surface, props.bodyColumns ?? 80, await now(), agents()));
  }
  if (parts.length === 0) return below;
  return parts.length === 1 ? parts[0] : elements.Box({ flexDirection: "column", children: parts });
}
