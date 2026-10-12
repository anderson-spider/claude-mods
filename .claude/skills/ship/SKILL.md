---
name: ship
description: Ship the current branch through checks, audit, PR, approved merge and plugin update.
disable-model-invocation: true
argument-hint: "[<plugin-name>...]"
---

# ship

Ship from an `andersonsilva/*` branch in its own worktree. Keep `main`, `master` and `develop` read-only: never commit, push, merge locally, rebase, reset or delete them. Require `AskUserQuestion` and `crew:architect`; stop if either is unavailable.

Plugins come from `$ARGUMENTS`; otherwise derive them from `git diff --name-only $(git merge-base origin/main HEAD)` plus `git ls-files --others --exclude-standard` (paths under `plugins/<name>/`).

## Steps

0. **Preflight**: fetch `origin main` before deriving the merge base; verify branch/worktree (creation task: `mise tasks info worktree:add`). Inventory modified, staged and untracked paths, expanding new directories. If the index is nonempty, list it and ask or stop: a commit takes the whole index. Query merged and open PRs for this head. With a merged PR and none open, if `git merge-base --is-ancestor <headRefOid> <branch>` succeeds, offer `git rebase --onto origin/main <headRefOid> <branch>` before proceeding; otherwise treat the name as reused. A rebased remote branch requires `--force-with-lease`, never `--force`.
1. **Checklist**: read `.claude/skills/release-plugin/SKILL.md` and run its Steps for this plugin list (explicitly pass the list; omit its Report). With no plugin touched, or with marketplace/scripts changes, also run `claude plugin validate .` and `node scripts/check-consistency.mjs`. Record all results.
2. **Gaps**: for each plugin changed outside `tests/`, bump its manifest version if it still equals `origin/main` (the cache is version-keyed); ask before a major bump. Fix README/AGENTS.md drift and rerun step 1. Proceed only with the checklist satisfied; stop and report after two repair rounds.
3. **Audit**: have `crew:architect` review the merge-base diff plus untracked files against the branch's intent in `.crew/reviews/ship-<name>.md` (strip `andersonsilva/`, replace remaining `/` with `-`). Require an in/out-of-scope classification for every current status path, including step 2 edits, which are in scope. Resolve or justify every finding before proceeding.
4. **Commit/push**: stage only audited in-scope paths with `git add -- <paths>`; never `-A`, `.` or `-a`. Verify the staged path set equals the in-scope set. Commit in English with Conventional Commits and the user's attribution rules; skip an empty commit. Push naming origin and branch explicitly (`-u`; `--force-with-lease` after the step 0 rebase).
5. **PR**: reuse the open PR for this head; create one only if none exists. Use `.github/pull_request_template.md` and root title/language conventions. Review the body with `humanizer` before publishing; describe actual validation by kind, without test counts or attribution.
6. **CI**: wait up to about 60 s for a check to appear, then watch `gh pr checks <n> --watch`; stop if none appears. On failure, fix, rerun steps 1 and 3 on the new diff, push and watch; stop after two repair rounds. For setup/network failures outside the diff, offer one `gh run rerun <run-id> --failed` (get the id from the branch's latest run).
7. **Approval**: one `AskUserQuestion` showing PR link, `baseRefName`, `isDraft`, `mergeStateStatus`, head SHA, CI, version bumps and audit result; options merge or stop. Continue only with explicit merge approval for that SHA.
8. **Merge/update**: `gh pr merge <n> --squash --match-head-commit <approved sha>`; never `--admin` or `--auto`. Verify state `MERGED` before updating. Let the repository delete the remote branch. Run `mise run plugins:update`; compare each shipped installed plugin (`claude plugin list --json`) with its merged manifest version. A mismatch is blocked; otherwise ask the user to run `/reload-plugins`.
9. **Report**: use the user's headings and language, ordered blocked on the user, changed, found. Include out-of-scope paths left behind. Suggest `/cleanup` from the main checkout or another session, not this merged worktree.
