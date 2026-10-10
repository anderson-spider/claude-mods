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
3. **Dispatch.** Call the `pantheon:<role>` agent named by the task's `role` (`developer` by default, `ux` for look and feel) with an Agent `description` that starts with `[<taskId>]`, for example `[T2] Add the export button`. The prefix links the agent to its task: the controller keeps it to the task's `files`, runs the task's checks when it returns, and refuses a task given to another role. Use it only for the task's implementer and for the reviewers below, never for code-reader, docs-reader or the council. Without a specialist, do the task yourself.
4. **Test first.** Every brief tells the implementer to write a failing test for the acceptance, then the code, then run the checks. It commits only its task's files once the checks pass, with `[<taskId>]` in the message, and never pushes.
5. **Follow the verdict.** When the agent returns, the controller's verdict is appended to the Agent result (or attached as context to the task notification, for a background agent), starting `[Pantheon flow]`. Do what it says, by what it says:
   - **`Task T is done. Next: T2 (...)`** (or `Still active: ...`): start the task it names, under its own `[<taskId>]`. **`... every required task is done. Stop to verify`**: nothing is left to delegate; end your turn so the Stop runs every task's checks and completes the flow, then use `finish`.
   - **`failed attempt N of M. Retry the same implementer with this output`** (also `tried to write N file(s) outside its files`): send the same implementer (keep its session when the role supports resume) the failing output, or the files it may write, under the same `[<taskId>]`. The controller counts the attempts: `limits.maxAttempts` is 2 unless the plan says otherwise, so one retry by default.
   - **`Ask the architect to diagnose it before another attempt`**: ask the architect, with `[<taskId>]` in the description, to diagnose it with the output and what was tried, then hand the diagnosis to the implementer. **`Move to F (...)`**: that task ran out of attempts and its `onFail` task is next: start F.
   - **`passes its checks but needs a QA verdict`**, **`is risky: ask the architect to review it`**, or **`needs two receipts`**: the task is not done yet; spawn the reviewer(s) it names, step 6.
   - **A pause** (`failed N times, past the limit`, `failed N times in a row with the same output`, `QA could not verify task`, `needs the architect ... disabled`, `no remaining task is eligible`, a regression of a `sideEffect` task): stop, tell the person what it says and wait. They resume with `/pantheon flow resume` or end the flow with `/pantheon flow stop`.
   - **A held Stop** (`Pantheon flow: Task T (...) is not done: its checks fail`, `Regression: task T ...`, `Task T is not finished`, or a task that still waits for a receipt): fix it through the implementer or the reviewer it names or, when its text says the attempts are spent, the architect with `[<taskId>]`, then stop again. `Waiting for N background task(s)` is not a block: wait for their notifications and start nothing that depends on them.
   - **A Stop that ends `unverified`** (`Checks could not run, so their tasks are unverified ... Create the directory the check needs, or ask the person to fix the plan and approve it`, or the same wording on a task end): a check could not run because its working directory is not there or its command did not start. It spends no attempt and the task is not failed. Do not retry the implementer for it: create the directory the check needs through the implementer (a task of its own or the same task's files), or tell the person that the plan's check must be fixed and approved again. Then stop again.
   - **A side-effect task paused with `ask_person`** (`is a side effect and its checks could not run ... check it by hand`): the effect may already have run, so it is never delegated again. Stop, tell the person to check it by hand, and wait: `/pantheon flow resume` marks the task done and starts what depends on it, `/pantheon flow stop` ends the flow.
   - **Never mark a task done yourself**, skip a check or edit a task's files while it awaits a receipt (that voids the receipts); send the fix to the implementer. A task is done when the controller says so.
6. **Review only when asked for.** Spawn a reviewer with `[<taskId>]` only while the controller says the task awaits it; ask for other reviews without the prefix.
   - **QA** for a task with `criteria`: brief it with the numbered criteria (C1, C2, ...), what changed (the task's commit) and how to run it. It answers `C<n>: pass|fail — evidence` per criterion and a final `QA: pass|fail|blocked`; it never fixes anything. A `pass` counts only when every criterion has its own passing line; an answer the controller cannot read is no receipt.
   - **Architect** for a task with `risk: true`: the implementer has already committed, and a rejection lands as a follow-up commit. Before the gate, write down what changed, the validation evidence and the specific risk, so the architect does not rediscover context, and ask it to put its findings first and end with a line `REVIEW: pass` or `REVIEW: fail`; without that line there is no receipt. A gate is one review and at most two re-reviews, and a re-review happens only when the fix changed the reviewed decision or risk.
7. **Commit and push.** The implementer has committed its task's files; check the commit with `git log`. If it did not, ask it to, or commit the task's paths yourself. You push.

When the controller reports every required task done, use `finish`.

## Without a flow

1. **Brief.** Build it from the task section and the interfaces it names, nothing else: goal, files, interfaces, acceptance, and the rule below. Reference paths instead of pasting files.
2. **Dispatch.** `developer` writes the code, UI code and logic included; `ux` takes the tasks about look and feel (layout, hierarchy, color, spacing, motion, UI copy) and implements them. Call its `pantheon:<role>` agent. Without a specialist, do the task yourself.
3. **Test first.** Every brief tells the implementer to write a failing test for the acceptance criterion, then the code, then run the tests. It commits only its task's files once the checks pass.
4. **Check.** Run the acceptance command yourself and read its output.
5. **Commit.** The implementer has committed its task's files with `[<taskId>]` in the message; check the commit with `git log`. If it did not, ask it to, or commit the task's paths yourself. You push.

Run tasks in sequence. Run them together only when the plan marks `parallel: yes` and their files are disjoint; each implementer owns its files. Read-only lanes (code-reader, docs-reader) always run in parallel. Keep one implementer session per task when the role supports resume, and reuse it for fixes.

Retry the same implementer once with the error and the output. If it fails again, ask the architect to diagnose. If that does not resolve it, stop and ask the person.

Only tasks marked `risk: yes` go to the architect. Before the gate, write down what changed, the validation evidence and the specific risk, so the architect does not rediscover context. A gate is one review and at most two re-reviews, and a re-review happens only when the fix changed the reviewed decision or risk. Fix what the review found, then check again.

When every task is done, use `finish`.
