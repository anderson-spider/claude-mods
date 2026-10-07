import { infoData } from "./info.mjs";

// Unity's YAML assets swell the line counts and slow the diff: left out of them.
const DIFF_EXCLUDES = ["*.unity", "*.prefab", "*.asset", "*.meta", "*.mat", "*.anim", "*.controller", "*.physicMaterial", "*.lighting"].map((g) => `:(exclude)${g}`);

// The folder, its branch, the files changed and the model (a /model switch shows within 10 s); true when
// something changed.
export async function refreshInfo({ cwd: readCwd, run, model: readModel }) {
  const before = JSON.stringify(infoData.current);
  try {
    const cwd = await readCwd();
    infoData.current.dir = cwd.split("/").filter(Boolean).pop() ?? "";
    const git = await run(["git", "--no-optional-locks", "branch", "--show-current"], { cwd, timeoutMs: 3000 });
    infoData.current.branch = git.exitCode === 0 ? git.stdout.trim() : "";
    infoData.current.files = infoData.current.added = infoData.current.removed = 0;
    if (git.exitCode === 0) {
      const status = await run(["git", "--no-optional-locks", "status", "--porcelain"], { cwd, timeoutMs: 3000 });
      infoData.current.files = status.exitCode === 0 ? status.stdout.split("\n").filter(Boolean).length : 0;
      if (infoData.current.files > 0) {
        const diff = await run(["git", "--no-optional-locks", "diff", "HEAD", "--numstat", "--", ".", ...DIFF_EXCLUDES], { cwd, timeoutMs: 3000 });
        for (const line of diff.exitCode === 0 ? diff.stdout.split("\n") : []) {
          const [a, r] = line.split("\t");
          infoData.current.added += Number(a) || 0;
          infoData.current.removed += Number(r) || 0;
        }
      }
    }
    // The host has no effort getter, so a switch with /model shows no effort until the next request.
    const model = await readModel();
    if (model !== infoData.sessionModel) {
      if (infoData.sessionModel !== "") infoData.current.effort = "";
      infoData.sessionModel = model;
      infoData.current.model = model;
    }
  } catch {
    // No folder or git here: the line shows what it has.
  }
  return JSON.stringify(infoData.current) !== before;
}
