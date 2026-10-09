// Adapted from hud (Apache-2.0), built on Token Weather Usage; see NOTICE and LICENSE-APACHE.

export const freshInfo = () => ({
  // What the info line shows: the last request's model and effort, the repository (or folder), and its git figures.
  current: { model: "", effort: "", speed: "", dir: "", branch: "", worktree: false, files: 0, added: 0, removed: 0 },
  // The last model returned by the host: a change in it is a /model switch, whatever the request ids look like.
  sessionModel: "",
});
export const infoData = freshInfo();

// ---------- Model label ----------

// "claude-sonnet-5-5" -> "Sonnet 5.5"; an id this does not know is shown as it came.
export function modelLabel(id) {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[\w+\])?$/.exec(id ?? "");
  if (!m) return String(id ?? "").replace(/^claude-/, "");
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}`;
}
