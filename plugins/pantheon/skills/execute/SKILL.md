---
name: execute
description: Use to carry out a written plan (for example one from grill). Dispatches each task to developer or ux, runs the tests, commits, and sends only risky tasks to the architect.
---

# Execute

Run `.pantheon/plans/<plan>.md` task by task.

## Per task

1. **Brief.** Build it from the task section and the interfaces it names, nothing else: goal, files, interfaces, acceptance, and the rule below. Reference paths instead of pasting files.
2. **Dispatch.** `developer` writes the code, UI code and logic included; `ux` takes the tasks about look and feel (layout, hierarchy, color, spacing, motion, UI copy) and implements them. Call its `pantheon:<role>` agent. Without a specialist, do the task yourself; when the git role is disabled, do the git work yourself too.
3. **Test first.** Every brief tells the implementer to write a failing test for the acceptance criterion, then the code, then run the tests. It commits only its task's files once the checks pass.
4. **Check.** Run the acceptance command yourself and read its output.
5. **Commit.** The implementer has committed its task's files with `[<taskId>]` in the message; check the commit with `git log`. If it did not, ask it to, or brief `pantheon:git` to commit the task's paths. You push; `pantheon:git` is for squash, PR/MR and branch or worktree changes.

## Order

- Run tasks in sequence. Run them together only when the plan marks `parallel: yes` and their files are disjoint; each implementer owns its files.
- Read-only lanes (code-reader, docs-reader) always run in parallel.
- Keep one implementer session per task when the role supports resume, and reuse it for fixes.

## When a task fails or blocks

Retry the same implementer once with the error and the output. If it fails again, ask the architect to diagnose. If that does not resolve it, stop and ask the person.

## Review

Only tasks marked `risk: yes` go to the architect. Before the gate, write down what changed, the validation evidence and the specific risk, so the architect does not rediscover context. A gate is one review and at most two re-reviews, and a re-review happens only when the fix changed the reviewed decision or risk. Fix what the review found, then check again.

When every task is done, use `finish`.
