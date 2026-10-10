---
name: execute
description: Use to carry out a written plan (for example one from brainstorm). Dispatches each task to developer or ux, follows the flow controller's verdicts, and sends only risky tasks to the architect.
---

# Execute

Run `.pantheon/plans/<plan>.md` task by task. If the plan carries a `pantheon-flow` block that the person approved with `/pantheon flow approve`, follow "With a flow"; otherwise follow "Without a flow". An unapproved block is not enforced: ask the person to approve it, and run the plan as one without a flow only if they say so.

## With a flow

The block is the contract: tasks, roles, files and acceptance come from it, and the controller checks them. You delegate and relay; the controller decides. The contract is the version the person approved: if you edit the block during the run, the controller adopts only purely additive edits (a new task at the end, an extra criterion, a raised `risk`; see brainstorm) and keeps running the approved version for everything else until the person runs `/pantheon flow approve` (it lists the commands and a hash, and the person confirms with the hash; you cannot run it for them); `/pantheon flow status` lists what waits. Never rely on an edit that is waiting. If the controller reports that the approved snapshot changed outside `/pantheon flow approve`, say so to the person and wait: do not edit `.pantheon/flow/` yourself.

1. **Pick.** The next task is one whose `dependsOn` are all done, in plan order. Run two together only when both are eligible and their `files` are disjoint; each implementer owns its files. Read-only lanes (code-reader, docs-reader) always run in parallel.
2. **Brief.** Build it from the task's entry in the block and the plan's notes for that task id, nothing else: goal, files, interfaces, acceptance (the checks to make pass and the criteria), and the rules below. Reference paths instead of pasting files.
3. **Dispatch.** Call the `pantheon:<role>` agent named by the task's `role` (`developer` by default, `ux` for look and feel) with an Agent `description` that starts with `[<taskId>]`, for example `[T2] Add the export button`. The prefix links the agent to its task: the controller keeps it to the task's `files`, runs the task's checks when it returns, and refuses a task given to another role. Use it only for the task's implementer and for the reviewers below, never for code-reader, docs-reader, git or the council. Without a specialist, do the task yourself; when the git role is disabled, do the git work yourself too.
4. **Test first.** Every brief tells the implementer to write a failing test for the acceptance, then the code, then run the checks. It commits only its task's files once the checks pass, with `[<taskId>]` in the message, and never pushes.
5. **Follow the verdict.** When the agent returns, the controller's verdict is appended to the Agent result (or attached to the task notification, for a background agent). Do what it says:
   - **retry**: send the same implementer (keep its session when the role supports resume) the failing output, under the same `[<taskId>]`. The controller counts the attempts and allows one retry by default.
   - **diagnose**: ask the architect, with `[<taskId>]` in the description, to diagnose it with the output and what was tried, then hand the diagnosis to the implementer.
   - **route**: start the task the verdict names (the next eligible one, or an `onFail` task).
   - **wait**: background work is still running; wait for its notifications and start nothing that depends on it.
   - **pause**: stop, tell the person what the verdict says and wait. They resume with `/pantheon flow resume` or end the flow with `/pantheon flow stop`.
   - **Never mark a task done yourself**, skip a check or edit a task's files while it awaits a receipt (that voids the receipts); send the fix to the implementer. A task is done when the controller says so.
6. **Review only when asked for.** Spawn a reviewer with `[<taskId>]` only while the controller says the task awaits it; ask for other reviews without the prefix.
   - **QA** for a task with `criteria`: brief it with the numbered criteria (C1, C2, ...), what changed (the task's commit) and how to run it. It answers `C<n>: pass|fail — evidence` per criterion and a final `QA: pass|fail|blocked`; it never fixes anything.
   - **Architect** for a task with `risk: true`: the implementer has already committed, and a rejection lands as a follow-up commit. Before the gate, write down what changed, the validation evidence and the specific risk, so the architect does not rediscover context, and ask for an explicit verdict. A gate is one review and at most two re-reviews, and a re-review happens only when the fix changed the reviewed decision or risk.
7. **Commit and push.** The implementer has committed its task's files; check the commit with `git log`. If it did not, ask it to, or brief `pantheon:git` to commit the task's paths. You push; `pantheon:git` is for squash, PR/MR and branch or worktree changes.

When the controller reports every required task done, use `finish`.

## Without a flow

1. **Brief.** Build it from the task section and the interfaces it names, nothing else: goal, files, interfaces, acceptance, and the rule below. Reference paths instead of pasting files.
2. **Dispatch.** `developer` writes the code, UI code and logic included; `ux` takes the tasks about look and feel (layout, hierarchy, color, spacing, motion, UI copy) and implements them. Call its `pantheon:<role>` agent. Without a specialist, do the task yourself; when the git role is disabled, do the git work yourself too.
3. **Test first.** Every brief tells the implementer to write a failing test for the acceptance criterion, then the code, then run the tests. It commits only its task's files once the checks pass.
4. **Check.** Run the acceptance command yourself and read its output.
5. **Commit.** The implementer has committed its task's files with `[<taskId>]` in the message; check the commit with `git log`. If it did not, ask it to, or brief `pantheon:git` to commit the task's paths. You push; `pantheon:git` is for squash, PR/MR and branch or worktree changes.

Run tasks in sequence. Run them together only when the plan marks `parallel: yes` and their files are disjoint; each implementer owns its files. Read-only lanes (code-reader, docs-reader) always run in parallel. Keep one implementer session per task when the role supports resume, and reuse it for fixes.

Retry the same implementer once with the error and the output. If it fails again, ask the architect to diagnose. If that does not resolve it, stop and ask the person.

Only tasks marked `risk: yes` go to the architect. Before the gate, write down what changed, the validation evidence and the specific risk, so the architect does not rediscover context. A gate is one review and at most two re-reviews, and a re-review happens only when the fix changed the reviewed decision or risk. Fix what the review found, then check again.

When every task is done, use `finish`.
