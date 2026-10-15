---
name: cleanup
description: List stale worktrees and merged or orphaned branches of the current git repository, then delete only what the user approves.
disable-model-invocation: true
argument-hint: "[dry-run]"
---

# cleanup

Clean up the git repository of the current directory: worktrees whose work is done or whose folder is gone, local branches already merged or whose remote branch is gone, and the user's own merged branches left on the remote. Work from the main checkout or any worktree. List first, delete only what the user approves item by item or by group, and never use `--force` on a worktree or a plain `--force` push.

With `dry-run` in `$ARGUMENTS`, stop after step 3 and change nothing (the `git fetch --prune` of step 1 still refreshes remote-tracking refs, which only mirror the remote).

## Rules that outrank any approval

- **Never touch**: the remote's default branch, `main`, `master`, `develop`, `release`, `release/*`, `release-*`, any branch the host reports as protected, and any branch the user's instructions (CLAUDE.md, memory, project rules) name as protected. These rows are Keep and cannot be selected. If the user asks to delete one anyway, refuse and give them the command to run themselves.
- **Own branches**: a branch is the user's own when its name starts with a prefix their instructions declare as theirs (for example `<name>/`). If no prefix is declared, ask once which prefix is theirs, or treat every branch as someone else's.
- **Someone else's branches**: only ever Ask rows, each needing an explicit item-level OK. Never delete someone else's remote branch unless the user names it.
- The main checkout and the worktree this session runs in are always Keep.
- Without a way to ask the user (no `AskUserQuestion` and no chat turn to wait on), stop after the listing.

## Steps

1. **Inventory**: `git fetch --all --prune`. Record:
   - the remote (`origin`, else the only remote; with none, work locally only) and its default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`, else the `HEAD branch` of `git remote show origin`);
   - the host CLI for that remote when one is installed and logged in (`gh` for GitHub, `glab` for GitLab, or the alias the user's instructions name for that host). With it, read each branch's pull or merge requests (number, state, head SHA, created and merged dates) and which branches the host protects. Without it, say so in the report and rely on git alone;
   - worktrees from `git worktree list --porcelain`: path, branch or detached HEAD, `locked`, `prunable` (folder gone), and for each existing one `git status --porcelain --ignored` (removal also deletes ignored files);
   - local branches with tip SHA, upstream and its track state (`git for-each-ref --format='%(refname:short) %(objectname) %(upstream:short) %(upstream:track)' refs/heads`; `[gone]` means the remote branch was deleted);
   - remote branches with the user's own prefix, with their tip (`git ls-remote <remote> 'refs/heads/<prefix>*'`).
   Finish when every worktree and branch has its tip, location, owner, status and merge evidence recorded.
2. **Merge evidence**, strongest first:
   - a pull or merge request: the newest one by creation date is merged and its head SHA equals the local tip (compare the strings; the commit may be gone after a squash);
   - the tip is an ancestor of `<remote>/<default>` (`git merge-base --is-ancestor`);
   - every commit ahead of the default branch is already applied there (`git cherry <remote>/<default> <branch>` prints only `-` lines), which catches squash and rebase merges without a host CLI.
   An upstream marked `[gone]` without any of these is not proof: the branch may have been deleted unmerged.
3. **Classify** each row Keep, Delete or Ask, Keep first:
   - **Keep**: everything under "Never touch", open pull or merge requests, locked worktrees, the main checkout, this session's worktree, worktrees open in another tool (when that tool can list them), and branches with commits not on the default branch and no merged request.
   - **Delete**: own branches with merge evidence whose tip matches it; their remote copy only when `git ls-remote <remote> refs/heads/<branch>` equals the local tip; their worktree only when it is clean (no changes, untracked or ignored files) and not open elsewhere; prunable worktree entries (folder already gone; `git worktree prune` only drops git's metadata).
   - **Ask**: everything else, with the reason: someone else's branch, a tip that moved after the merge (show those commits), a request closed unmerged (show the date), an upstream `[gone]` without merge evidence, a worktree with changes, untracked or ignored files (name them; say which look regenerable, such as build output or dependency folders), a detached worktree, a worktree managed by another tool (prefer that tool's own removal command; read its `--help` first), a branch with no request and nothing ahead of the default branch.
   Print a numbered table: item, kind (worktree, local branch, remote branch), class, reason, proposed action, local and remote tip SHAs. With `dry-run`, stop here.
4. **Approval**: ask once, offering "Delete group" (every Delete row), "Choose by number" (any Delete or Ask rows, by their numbers) and "Cancel". Keep rows are never selectable. An Ask row for someone else's branch needs its own explicit OK, not just its number in a range. Without `AskUserQuestion`, end the turn with the table and the question, and act only on the user's reply. Echo the approved list before acting.
5. **Execute**, in this order, re-checking each tip just before acting and skipping (with the reason) any row that changed:
   - worktrees: `git worktree remove <path>`, never `--force`; a tool-managed one with its tool's command;
   - local branches: `git branch -D <branch>` only while `git rev-parse refs/heads/<branch>` equals the table SHA; skip one still checked out in a kept worktree;
   - remote branches: `git push --force-with-lease=refs/heads/<branch>:<table sha> <remote> --delete <branch>`, which refuses if the tip moved;
   - finally `git worktree prune`.
   Verify each approved row is gone, or record why it was skipped.
6. **Report** in the user's language, under their report headings when their instructions set them (otherwise: blocked on you, changed, found): every removed and skipped row with its reason, what was kept and why in one line per group, and whether merge evidence came from the host or from git alone.
