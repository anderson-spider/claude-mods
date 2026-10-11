---
name: cleanup
description: Remove merged andersonsilva/* branches and their worktrees after one approval; use after PRs are merged
disable-model-invocation: true
---

# cleanup

Prunes local and remote branches and worktrees whose work already reached `main`, and asks about everything else. Run it from the main checkout or another session.

Never touch `main`, `master` or `develop`. If `AskUserQuestion` is unavailable, stop: its absence is not approval.

## Steps

1. **Inventory**: `git fetch --prune`, `git worktree list --porcelain`, the local and remote branches, and for each branch `gh pr list --head <branch> --state all --json number,state,headRefOid,mergedAt,closedAt,createdAt`. If a worktree manager's CLI that lists worktrees is on `PATH`, read its list and treat entries it reports as open as Keep. For each worktree run `git status --porcelain` and `git status --porcelain --ignored`, because `git worktree remove` deletes ignored files without a warning.
2. **Classify**:
   - **Delete** (the only group that needs a positive match): an `andersonsilva/*` branch whose most recent PR (by `createdAt`) is merged and whose local tip equals that PR's `headRefOid` (a string compare; the object may be missing locally); its remote copy only if `git ls-remote origin refs/heads/<branch>` also equals `headRefOid`; its worktree when clean, not open in another tool and inside the directory where this repository's `git worktree add` worktrees live. Put the local and remote tip SHAs in the table.
   - **Ask**: a merged PR with a different tip (show the commits after `headRefOid`, or "tip differs"), a PR closed without merge (show the date), a branch outside the prefix, a worktree with uncommitted, unpushed or ignored files (name them, e.g. `.crew/`; ignore regenerable `plugins/*/.claude-plugin/types/`), a worktree outside that directory or one another tool created, Herdr's worktrees of this repository included (remove it with that tool's own command when it can address the worktree; when it cannot, as with a Herdr worktree listed by `herdr worktree list` and having no open workspace, since `herdr worktree remove` takes only `--workspace <ID>` of an open workspace, runs `git worktree remove` itself and never deletes the branch, use `git worktree remove <path>` without `--force`; then check `herdr worktree list`, report an entry still listed and delete nothing in Herdr), and anything not matched by Delete or Keep, such as a branch with no PR and no commits ahead of `origin/main` or a remote-only branch.
   - **Keep**: `main`/`master`/`develop`, a branch with an open PR, a branch with no PR and commits ahead of `origin/main`, a locked worktree, a worktree open in another tool (a Herdr-managed one open in a workspace), the main checkout, and the worktree this session runs in (say so).
3. **Plan**: print one numbered table (no., item, type, reason, action). Then one `AskUserQuestion` with "Delete group" (Delete rows only, never Ask rows), "Choose by number" (the user types numbers as free text, Ask rows included) and "Cancel". Keep rows (including `main`/`master`/`develop`) cannot be picked by number. Echo the final list before running.
4. **Execute**: for each chosen item, `git worktree remove <path>` (never `--force`), `git branch -D <branch>` only if `git rev-parse refs/heads/<branch>` still equals the SHA in the table (a branch checked out in a worktree you keep stays and is reported as skipped), `git push --force-with-lease=refs/heads/<branch>:<table sha> origin --delete <branch>` so the remote check is atomic, then `git worktree prune` (it also clears a listed worktree whose folder is gone). Anything outside `andersonsilva/*` is deleted only on an explicit OK for that item.
5. **Report**: three sections in this order: blocked on the user, changed, found (the user's global instructions set the exact headings and language, e.g. "Blocked on me / Changed / Found"). List removed and skipped items with reasons.
