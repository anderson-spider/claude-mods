---
name: cleanup
description: Remove merged branches and worktrees after an approved cleanup plan.
disable-model-invocation: true
---

# cleanup

Prune work merged into `main`, from the main checkout or another session. Keep protected branches (`main`, `master`, `develop`) intact. Require explicit approval through `AskUserQuestion`; if unavailable, stop without deleting.

## Steps

1. **Inventory**: fetch with `--prune`; list worktrees (`git worktree list --porcelain`), local/remote branches and each head's PRs with number, state, head SHA and creation/merge/close dates. Read worktree-manager lists when available; open entries are Keep. Collect ordinary and ignored status for every worktree (removal deletes ignored files too). Finish when every branch/worktree has its PR history, tips, location, ownership and status recorded.
2. **Classify** (Keep takes precedence):
   - **Keep**: protected branches, open PRs, branches with no PR and commits ahead of `origin/main`, locked worktrees, worktrees open in another tool, the main checkout and this session's worktree (identify it).
   - **Delete**: only `andersonsilva/*` whose newest PR by `createdAt` is merged and whose local tip equals its `headRefOid` (compare strings; the object may be absent). Include its remote copy only when `git ls-remote origin refs/heads/<branch>` equals that SHA. Include its worktree only when clean, not open elsewhere and inside the sibling `claude-mods-worktrees/` directory created by `worktree:add`. Record local and remote tip SHAs separately.
   - **Ask**: everything else: differing tips (show post-merge commits or "tip differs"), closed-unmerged PRs (show date), other prefixes, uncommitted/unpushed/ignored files (name them; exempt only regenerable `plugins/*/.claude-plugin/types/`), outside/tool-managed worktrees, no-PR branches with no commits ahead and remote-only branches. For a tool-managed worktree, consult that tool's `--help` before choosing its removal command. Prefer its own command when it can address the worktree; otherwise use unforced Git removal, recheck the manager's list, report stale entries and leave manager state unchanged.
   Finish when every inventory row is classified Keep, Delete or Ask with its reason and eligible actions.
3. **Approval**: print a numbered table (item, type, reason, action, tip SHAs). Ask once: "Delete group" selects only Delete rows; "Choose by number" accepts free-text numbers including Ask rows; "Cancel" stops. Keep rows cannot be selected. Require an explicit item-level OK for any branch outside `andersonsilva/*`. Echo the approved list before execution; proceed only when each selected row meets its approval rule.
4. **Execute**: remove only approved worktrees with `git worktree remove <path>`, never `--force`. Delete a local branch with `git branch -D <branch>` only if `git rev-parse refs/heads/<branch>` still equals its table SHA; skip/report a branch checked out in a retained worktree. Delete a remote branch with `git push --force-with-lease=refs/heads/<branch>:<table sha> origin --delete <branch>` for an atomic tip check; never plain `--force`. Finish with `git worktree prune`; verify and report the removed or skipped state of every approved item.
5. **Report**: use the user's headings and language, ordered blocked on the user, changed, found. Finish when every removed or skipped item has a reason in the report.
