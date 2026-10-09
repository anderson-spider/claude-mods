// Adapted from hud (Apache-2.0), built on Token Weather Usage; see NOTICE and LICENSE-APACHE.
import { T, SEP, RESERVED_COLUMNS, TINTS, ink } from "./constants";
import { separator, pill } from "./drawing";

export const freshInfo = () => ({
  // What the info line shows: the last request's model and effort, the repository (or folder), and its git figures.
  current: { model: "", effort: "", speed: "", dir: "", branch: "", worktree: false, files: 0, added: 0, removed: 0 },
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

// The first row of the band, on both surfaces. Drops the least useful parts until it fits: the
// changes, the effort, the worktree mark, the repository. `gap` is the space before a part that
// hangs on the one before it, with no divider; in the app such a part shares the pill before it.
export function drawInfo(elements, columns, surface = "terminal") {
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
    // Fast mode: the first part to go when the row runs out of room.
    { key: "speed", text: cur.speed === "fast" ? "⚡fast" : "", drop: -1, gap: 3 },
  ].filter((p) => p.text !== "");
  if (parts.length === 0) return null;
  const width = () => 2 + parts.reduce((n, p, i) => n + p.text.length + (i === 0 ? 0 : p.gap ?? 3), 0);
  while (width() > columns - RESERVED_COLUMNS) {
    const victim = parts.filter((p) => p.drop !== undefined).sort((a, b) => a.drop - b.drop)[0];
    if (!victim) break;
    parts.splice(parts.indexOf(victim), 1);
  }
  const desktop = surface === "desktop";
  const mode = desktop ? "svg" : "text";
  const nodes = parts.map((p) => {
    if (p.key === "changes") {
      const lines = counts ? [Text({ key: "added", color: ink("calm", mode), children: `+${cur.added}` }), Text({ key: "removed", color: ink("alert", mode), children: `-${cur.removed}` })] : [];
      const label = p.text.replace(/ \+\d+ -\d+$/, "");
      return Box({ key: "changes", flexDirection: "row", columnGap: 1, children: [Text({ key: "files", dimColor: true, children: label }), ...lines] });
    }
    // The branch is red with a * while the tree has changes, green when it is clean.
    const color = p.key === "branch" ? ink(dirty ? "alert" : "calm", mode) : p.key === "speed" ? "#e5c07b" : undefined;
    return Text({ key: p.key, bold: p.bold === true, color, dimColor: p.key === "dir" || p.key === "effort" || p.key === "worktree", children: p.text });
  });
  if (desktop) {
    // Pills: the model with its effort, the repository, the branch with its marks.
    const pills = [];
    parts.forEach((p, i) => {
      if (p.gap === undefined || pills.length === 0 || p.key === "speed") pills.push({ key: "info-" + p.key, tint: TINTS[{ model: "model", dir: "repo", speed: "model" }[p.key] ?? (dirty ? "alert" : "clean")], parts: [] });
      // The effort hangs on the model with no space, as in the terminal.
      const last = pills[pills.length - 1];
      if (p.gap === 0) last.parts.push(Box({ key: "joined-" + p.key, flexDirection: "row", children: [last.parts.pop(), nodes[i]] }));
      else last.parts.push(nodes[i]);
    });
    // The same gap below as between the rows of pills under it.
    return Box({ key: "info", flexDirection: "row", alignItems: "center", columnGap: 1, paddingX: 1, marginBottom: 1, children: pills.map((b) => pill(elements, b)) });
  }
  const children = [];
  parts.forEach((p, i) => {
    if (i > 0 && p.gap === undefined) children.push(separator(Box, Text, "sep-" + i, SEP));
    const node = p.key === "changes" ? Box({ key: "gap-changes", paddingLeft: 1, children: [nodes[i]] }) : nodes[i];
    children.push(p.gap && p.key !== "changes" ? Box({ key: "gap-" + p.key, paddingLeft: p.gap, children: [node] }) : node);
  });
  return Box({ key: "info", flexDirection: "row", paddingX: 1, children });
}
