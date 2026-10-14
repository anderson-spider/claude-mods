---
name: ship
description: Ship the current branch through checks, review, PR, approved merge and plugin update.
disable-model-invocation: true
argument-hint: "[<plugin-name>...]"
---

# ship

Ship from an `andersonsilva/*` branch, never from `main`. Keep `main`, `master` and `develop` read-only: never commit, push, merge locally, rebase, reset or delete them; make changes only on your branch. Require `AskUserQuestion`; stop if it is unavailable.

Plugins come from `$ARGUMENTS`; otherwise derive them from `git diff --name-only $(git merge-base origin/main HEAD)` plus `git ls-files --others --exclude-standard` (paths under `plugins/<name>/`).

## Steps

0. **Preflight**: fetch `origin main` before deriving the merge base; verify the branch. Inventory modified, staged and untracked paths, expanding new directories. If the index is nonempty, list it and ask or stop: a commit takes the whole index. Query merged and open PRs for this head. With a merged PR and none open, if `git merge-base --is-ancestor <headRefOid> <branch>` succeeds, offer `git rebase --onto origin/main <headRefOid> <branch>` before proceeding; otherwise treat the name as reused. Use `--force-with-lease` for a rebased remote branch, never plain `--force`. Record branch, index, worktree paths and PR state.
1. **Checklist**: run the Steps in `.claude/skills/release-plugin/SKILL.md` for this plugin list (explicitly pass it; omit its Report). With no plugin touched, or with marketplace/scripts changes, also run `claude plugin validate .` and `node scripts/check-consistency.mjs`. Record each result or skipped check.
2. **Gaps**: for each plugin with a changed shipped file (any file under `plugins/<name>/` except `tests/`, `helper/test/`, `docs/`, the root `*.md` files and `*.test.*` files; see root `AGENTS.md` Conventions), bump its manifest version if it still equals `origin/main` (the cache is version-keyed); ask before a major bump. Fix README/AGENTS.md drift and rerun step 1. Proceed only when the checklist passes; stop and report after two repair rounds.
3. **Review**: review the merge-base diff plus untracked files yourself against the branch's intent and record it in `.crew/reviews/ship-<name>.md` (strip `andersonsilva/`, replace remaining `/` with `-`): bugs, regressions, project rules, test coverage, and an in/out-of-scope classification for every current status path, including step 2 edits, which are in scope. Proceed when every finding is resolved or justified and every status path is classified.
4. **Commit/push**: stage only reviewed in-scope paths with `git add -- <paths>`; never `-A`, `.` or `-a`. Verify the staged path set equals the in-scope set. Commit in English with Conventional Commits and the user's attribution rules; skip an empty commit. Push naming origin and branch explicitly (`-u`; `--force-with-lease` after the step 0 rebase). Verify the pushed head matches the reviewed commit.
5. **PR**: reuse the open PR for this head; create one only if none exists. Use `.github/pull_request_template.md` and root title/language conventions. Review the body with `humanizer` before publishing; describe actual validation by kind, without test counts or attribution. Record the open PR for this head.
6. **CI**: wait up to about 60 s for a check to appear, then watch `gh pr checks <n> --watch`; stop if none appears. On failure, fix, rerun steps 1 and 3 on the new diff, push and watch; stop after two repair rounds. For setup/network failures outside the diff, offer one `gh run rerun <run-id> --failed` (get the id from the branch's latest run). Proceed with passing CI; otherwise report the blocker.
7. **Approval**: one `AskUserQuestion` showing PR link, `baseRefName`, `isDraft`, `mergeStateStatus`, head SHA, CI, version bumps and review result; options merge or stop. Continue only with explicit merge approval for that SHA; otherwise stop and report.
8. **Merge/update**: `gh pr merge <n> --squash --match-head-commit <approved sha>`; never `--admin` or `--auto`. Verify state `MERGED` before updating. Let the repository delete the remote branch. Run `mise run plugins:update`; compare each shipped installed plugin (`claude plugin list --json`) with its merged manifest version. If versions mismatch, report the blocker; otherwise ask the user to run `/reload-plugins`. Record the merged state and each installed version.
9. **Report**: use the user's headings and language, ordered blocked on the user, changed, found. List every out-of-scope path left behind. Suggest `/cleanup` from the main checkout or another session, not this merged worktree.
