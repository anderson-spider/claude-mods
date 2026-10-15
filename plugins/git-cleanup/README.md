# git-cleanup

A skill that cleans up the git repository you are in: worktrees whose work is merged or whose folder is gone, local branches already merged or whose remote branch was deleted, and your own merged branches still on the remote. It lists everything first and deletes only what you approve.

```text
/plugin install git-cleanup@spider-claude-mods
```

Installed at user scope (the default), it works in every repository.

## Use

From the main checkout or any worktree, run `/git-cleanup:cleanup`. Add `dry-run` to see the table without changing anything.

The skill fetches with `--prune`, then classifies every worktree and branch:

- **Keep**: the default branch, `main`, `master`, `develop`, `release` and `release/*` or `release-*` branches, branches the host protects or your instructions name as protected, open pull or merge requests, locked worktrees, the main checkout and the session's own worktree. These cannot be selected, even if you ask.
- **Delete**: your own branches (the prefix your CLAUDE.md or memory declares as yours, such as `<name>/`) with proof they were merged, their remote copy when it still points at the same commit, their clean worktrees, and worktree entries whose folder is already gone.
- **Ask**: everything else, with the reason: someone else's branch, a branch whose remote is gone but whose merge is not proven, a worktree with changes or ignored files, a tip that moved after the merge.

You approve the Delete group or pick rows by number; someone else's branch needs its own OK. Removal never forces: `git worktree remove` without `--force`, `git branch -D` only while the tip is the one listed, and remote deletion with `--force-with-lease` on that tip.

Merge proof comes from the host when `gh` (GitHub) or `glab` (GitLab) is installed and logged in, or from the CLI your instructions name for that host; otherwise from git alone: the tip is in the default branch, or every commit ahead of it is already applied there (squash and rebase merges).

## Privacy

The skill runs git and, when present, the host CLI on your machine. It sends nothing anywhere else and stores nothing.

## Tests

None: the plugin ships one skill and no hooks module, so `claude plugin test` has nothing to load. `claude plugin validate --strict` and `node scripts/check-consistency.mjs` check its manifest and skill frontmatter. For editing pointers, see [AGENTS.md](AGENTS.md).
