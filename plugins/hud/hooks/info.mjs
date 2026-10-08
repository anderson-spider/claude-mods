import { T, SEP, TERM_TONES, RESERVED_COLUMNS } from "./constants.mjs";
import { separator } from "./drawing.mjs";

export const freshInfo = () => ({
  // What the info line shows: the last request's model and effort, the repository (or folder), and its git figures.
  current: { model: "", effort: "", dir: "", branch: "", worktree: false, files: 0, added: 0, removed: 0 },
  // The last model returned by the host: a change in it is a /model switch, whatever the request ids look like.
  sessionModel: "",
});
export const infoData = freshInfo();

// ---------- Info line: model·effort | repository | branch ⎇wt · changes ----------

// "claude-sonnet-5-5" -> "Sonnet 5.5"; an id this does not know is shown as it came.
function modelLabel(id) {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[\w+\])?$/.exec(id ?? "");
  if (!m) return String(id ?? "").replace(/^claude-/, "");
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}`;
}

// The subagents running now, by model: "2× Haiku 5.5 · Sonnet 5.5"; one with no request yet goes by its type.
export function agentModels(agents) {
  const counts = new Map();
  for (const a of agents) {
    const label = a.model ? modelLabel(a.model) : a.type || "agent";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => (n > 1 ? `${n}× ${label}` : label)).join(" · ");
}

// The first row of the band, on both surfaces. Drops the least useful parts until it fits: the
// changes, the effort, the worktree mark, the repository. `gap` is the space before a part that
// hangs on the one before it, with no divider.
export function drawInfo(elements, columns) {
  const { Box, Text } = elements;
  const cur = infoData.current;
  const dirty = cur.files > 0;
  const counts = cur.added || cur.removed ? ` +${cur.added} -${cur.removed}` : "";
  const changes = dirty ? `· ${cur.files} ${cur.files === 1 ? "file" : "files"}${counts}` : "";
  const parts = [
    { key: "model", text: cur.model ? modelLabel(cur.model) : "", bold: true },
    { key: "effort", text: cur.model && cur.effort ? `·${cur.effort}` : "", drop: 1, gap: 0 },
    { key: "dir", text: cur.dir, drop: 3 },
    { key: "branch", text: cur.branch && dirty ? `${cur.branch}*` : cur.branch },
    { key: "worktree", text: cur.branch && cur.worktree ? T.worktree : "", drop: 2, gap: 1 },
    { key: "changes", text: cur.branch ? changes : "", drop: 0, gap: 1 },
  ].filter((p) => p.text !== "");
  if (parts.length === 0) return null;
  const width = () => 2 + parts.reduce((n, p, i) => n + p.text.length + (i === 0 ? 0 : p.gap ?? 3), 0);
  while (width() > columns - RESERVED_COLUMNS) {
    const victim = parts.filter((p) => p.drop !== undefined).sort((a, b) => a.drop - b.drop)[0];
    if (!victim) break;
    parts.splice(parts.indexOf(victim), 1);
  }
  const children = [];
  parts.forEach((p, i) => {
    if (i > 0 && p.gap === undefined) children.push(separator(Box, Text, "sep-" + i, SEP));
    if (p.key === "changes") {
      const lines = counts ? [Text({ key: "added", color: TERM_TONES.calm, children: `+${cur.added}` }), Text({ key: "removed", color: TERM_TONES.alert, children: `-${cur.removed}` })] : [];
      const label = p.text.replace(/ \+\d+ -\d+$/, "");
      children.push(Box({ key: "changes", flexDirection: "row", columnGap: 1, paddingLeft: 1, children: [Text({ key: "files", dimColor: true, children: label }), ...lines] }));
      return;
    }
    // The branch is red with a * while the tree has changes, green when it is clean.
    const color = p.key === "branch" ? (dirty ? TERM_TONES.alert : TERM_TONES.calm) : undefined;
    const text = Text({ key: p.key, bold: p.bold === true, color, dimColor: p.key === "dir" || p.key === "effort" || p.key === "worktree", children: p.text });
    children.push(p.gap ? Box({ key: "gap-" + p.key, paddingLeft: p.gap, children: [text] }) : text);
  });
  return Box({ key: "info", flexDirection: "row", paddingX: 1, children });
}
