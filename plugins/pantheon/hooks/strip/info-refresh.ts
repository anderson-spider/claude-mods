// Adapted from hud (Apache-2.0), built on Token Weather Usage; see NOTICE and LICENSE-APACHE.
import { infoData } from "./info";

// Unity's YAML assets swell the line counts and slow the diff: left out of them.
const DIFF_EXCLUDES = ["*.unity", "*.prefab", "*.asset", "*.meta", "*.mat", "*.anim", "*.controller", "*.physicMaterial", "*.lighting"].map((g) => `:(exclude)${g}`);

// The repository (or folder), its branch and whether it is a worktree, the files changed and the model (a /model switch shows within 10 s); true when
// something changed.
export async function refreshInfo({ cwd: readCwd, run, model: readModel }) {
  const before = JSON.stringify(infoData.current);
  try {
    const cwd = await readCwd();
    infoData.current.dir = cwd.split("/").filter(Boolean).pop() ?? "";
    const git = await run(["git", "--no-optional-locks", "branch", "--show-current"], { cwd, timeoutMs: 3000 });
    infoData.current.branch = git.exitCode === 0 ? git.stdout.trim() : "";
    infoData.current.worktree = false;
    infoData.current.files = infoData.current.added = infoData.current.removed = 0;
    if (git.exitCode === 0) {
      // A linked worktree has a git dir of its own beside the common one, whose folder names the
      // repository: the line shows the repository, not the worktree's folder.
      const dirs = await run(["git", "--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd, timeoutMs: 3000 });
      const [gitDir, commonDir] = dirs.exitCode === 0 ? dirs.stdout.trim().split("\n") : [];
      if (gitDir && commonDir) {
        infoData.current.worktree = gitDir !== commonDir;
        const repo = commonDir.endsWith("/.git") ? commonDir.slice(0, -5).split("/").filter(Boolean).pop() : "";
        if (repo) infoData.current.dir = repo;
      }
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
