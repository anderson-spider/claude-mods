---
name: grill
description: Use before creative or multi-step work (a feature, a refactor, a behavior change) to agree what to build, then write the plan. Interviews the person one question at a time, reads code and docs through the explorer and librarian, opens a worktree and writes a single plan.
---

# Grill

Turn a request into a plan the person has agreed to. No code, no spec file: one plan.

## 1. Understand

- Read before asking. Dispatch the explorer for code and the librarian for external docs, in parallel when both apply. Do not ask what the repository or the docs already answer.
- Ask one question at a time, each with your recommendation and the reason. Prefer a choice over an open question. Stop asking when the purpose, the constraints and the success criteria are clear.
- Write the understanding back in a few lines: what the person said, what you assumed. Wait for a correction or a yes.
- If the request holds several independent pieces, split it and plan the first one.

## 2. Open the worktree

- Call `EnterWorktree` with a `name` taken from the topic. It creates the worktree and its branch in one step; do not create a branch separately. If the project's rules name branches differently, rename the new branch with `git branch -m` before the first commit.
- If the session already runs in a worktree, stay in it.
- With the default `worktree.baseRef` (`fresh`) the worktree starts from `origin/<default branch>`. Say so when the work depends on commits that are not on the remote.

## 3. Write the plan

- Path: `.pantheon/plans/YYYY-MM-DD-<topic>.md`. Add `.pantheon/` to the file printed by `git rev-parse --git-path info/exclude` (a worktree's `.git` is a file, so do not write to `.git/info/exclude` directly; create the line once); never commit the plan or touch a tracked ignore file.
- Start with a short context and the decisions already made, then the tasks. Each task has:
  - **goal**: what changes and why, in a sentence or two;
  - **files**: the paths it may touch;
  - **interfaces**: the signatures, types or contracts it uses or exposes;
  - **acceptance**: how to tell it is done, as a command or an observable result;
  - **risk**: `yes` or `no`. `yes` for security, data integrity, shared contracts or hard-to-reverse changes;
  - **parallel**: `yes` only when you are sure the task is independent of the others and shares no files with them; otherwise `no`.
- No code in the plan and no text copied from another section: refer to it.
- Show the plan and wait for the person's approval before `execute` runs.
