import { TERM_TONES, RESERVED_COLUMNS } from "./constants.mjs";
import { separator } from "./drawing.mjs";

export const freshInfo = () => ({
  // What the info line shows: the last request's model, effort and speed, and the folder's git figures.
  current: { model: "", effort: "", speed: null, dir: "", branch: "", files: 0, added: 0, removed: 0 },
  // The last model returned by the host: a change in it is a /model switch, whatever the request ids look like.
  sessionModel: "",
});
export const infoData = freshInfo();

// ---------- Info line: model, effort, speed, folder, branch ----------

// "claude-sonnet-5-5" -> "Sonnet 5.5"; an id this does not know is shown as it came.
function modelLabel(id) {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[\w+\])?$/.exec(id ?? "");
  if (!m) return String(id ?? "").replace(/^claude-/, "");
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}`;
}

// Output tokens per second of one request; a request too short to measure leaves the last figure.
export function recordSpeed(tokens, ms) {
  if (Number.isFinite(tokens) && tokens > 0 && ms > 500) infoData.current.speed = Math.round((tokens * 1000) / ms);
}

// The subagents running now, by model: "2× Haiku 5.5 · Sonnet 5.5"; one with no request yet is "agent".
export function agentModels(agents) {
  const counts = new Map();
  for (const a of agents) {
    const label = a.model ? modelLabel(a.model) : "agent";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => (n > 1 ? `${n}× ${label}` : label)).join(" · ");
}

// One row above the usage line. Drops the least useful parts until it fits: the changes, speed,
// effort, folder. The subagents have their own block on the usage line.
export function drawInfo(elements, columns) {
  const { Box, Text } = elements;
  const changes = infoData.current.files > 0 ? `· ${infoData.current.files} ${infoData.current.files === 1 ? "file" : "files"}${infoData.current.added || infoData.current.removed ? ` +${infoData.current.added} -${infoData.current.removed}` : ""}` : "";
  const parts = [
    { key: "model", text: modelLabel(infoData.current.model), bold: true },
    { key: "effort", text: infoData.current.effort, drop: 2 },
    { key: "speed", text: infoData.current.speed === null ? "" : `${infoData.current.speed} tok/s`, drop: 0 },
    { key: "dir", text: infoData.current.dir, drop: 3 },
    { key: "branch", text: infoData.current.branch && infoData.current.files > 0 ? `${infoData.current.branch}*` : infoData.current.branch },
    // Hangs on the branch, with no divider.
    { key: "changes", text: infoData.current.branch ? changes : "", drop: -1, attached: true },
  ].filter((p) => p.text !== "");
  if (parts.length === 0) return null;
  const width = () => 2 + parts.reduce((n, p, i) => n + p.text.length + (i === 0 ? 0 : p.attached ? 1 : 3), 0);
  while (width() > columns - RESERVED_COLUMNS) {
    const victim = parts.filter((p) => p.drop !== undefined).sort((a, b) => a.drop - b.drop)[0];
    if (!victim) break;
    parts.splice(parts.indexOf(victim), 1);
  }
  const children = [];
  parts.forEach((p, i) => {
    if (p.key === "changes") {
      const counts = infoData.current.added || infoData.current.removed ? [Text({ key: "added", color: TERM_TONES.calm, children: `+${infoData.current.added}` }), Text({ key: "removed", color: TERM_TONES.alert, children: `-${infoData.current.removed}` })] : [];
      const label = p.text.replace(/ \+\d+ -\d+$/, "");
      children.push(Box({ key: "changes", flexDirection: "row", columnGap: 1, paddingLeft: 1, children: [Text({ key: "files", dimColor: true, children: label }), ...counts] }));
      return;
    }
    if (i > 0) children.push(separator(Box, Text, "sep-" + i, "|"));
    // The branch is red with a * while the tree has changes, green when it is clean.
    const color = p.key === "branch" ? (infoData.current.files > 0 ? TERM_TONES.alert : TERM_TONES.calm) : undefined;
    children.push(Text({ key: p.key, bold: p.bold === true, color, dimColor: p.key === "dir" || p.key === "speed", children: p.text }));
  });
  return Box({ key: "info", flexDirection: "row", paddingX: 1, children });
}
