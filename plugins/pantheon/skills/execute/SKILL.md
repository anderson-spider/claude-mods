---
name: execute
description: Use to carry out a written plan (for example one from brainstorm). Dispatches each task to developer or ux, follows the flow controller's verdicts, and sends only risky tasks to the architect.
---

# Execute

Run `.pantheon/plans/<plan>.md` task by task. If the plan has a `pantheon-flow` block the person approved with `/pantheon flow approve`, follow "With a flow"; otherwise follow "Without a flow". An unapproved block is not enforced: ask the person to approve it, and run without a flow only if they say so.

## With a flow

The block is the contract and the controller decides; you delegate and relay. The approved version governs: the controller adopts only purely additive edits made during the run (see brainstorm), and every other edit waits for `/pantheon flow approve`, which `/pantheon flow status` lists. Never rely on an edit that waits. If the controller says the approved snapshot changed outside `/pantheon flow approve`, tell the person and wait; do not edit `.pantheon/flow/` yourself.

1. **Pick.** The next task is one whose `dependsOn` are all done, in plan order. Run two together only when both are eligible and their `files` are disjoint. Read-only lanes (code-reader, docs-reader) always run in parallel.
2. **Brief.** Build it from the task's entry in the block and the plan's notes for its id, nothing else: goal, files, interfaces, acceptance (checks and criteria) and the rules in steps 3 and 4. Reference paths instead of pasting files.
3. **Dispatch.** Call the `pantheon:<role>` agent named by the task's `role` (`developer` by default, `ux` for look and feel), with an Agent `description` starting `[<taskId>]`, for example `[T2] Add the export button`. The prefix links the agent to its task: the controller keeps it to the task's `files`, runs its checks when it returns, and refuses a task given to another role. Use the prefix only for the implementer and the reviewers below, never for code-reader, docs-reader or the council. Without a specialist, do the task yourself.
4. **Test first.** Tell the implementer to write a failing test for the acceptance, then the code, then run the checks. Once they pass, it commits only its task's files with `[<taskId>]` in the message, and never pushes.
5. **Follow the verdict.** The controller's verdict is appended to the Agent result (or attached to the task notification, for a background agent), starting `[Pantheon flow]`. Do what it says, by what it says:
   - **`Task T is done. Next: T2 (...)`** (or `Still active: ...`): start the task it names under its own `[<taskId>]`. **`... every required task is done. Stop to verify`**: nothing is left to delegate; end your turn so the Stop runs every task's checks and completes the flow, then use `finish`.
   - **`failed attempt N of M. Retry the same implementer with this output`** (or `tried to write N file(s) outside its files`): send the same implementer (resume its session when the role supports it) the output, or the files it may write, under the same `[<taskId>]`. `limits.maxAttempts` is 2 unless the plan says otherwise, so one retry by default.
   - **`Ask the architect to diagnose it before another attempt`**: ask the architect, with `[<taskId>]` in the description, for a diagnosis, giving it the output and what was tried; then hand the diagnosis to the implementer. **`Move to F (...)`**: the task ran out of attempts; start its `onFail` task F.
   - **`passes its checks but needs a QA verdict`**, **`is risky: ask the architect to review it`** or **`needs two receipts`**: not done yet; spawn the reviewer(s) it names (step 6).
   - **A pause** (`failed N times, past the limit`, `failed N times in a row with the same output`, `QA could not verify task`, `needs the architect ... disabled`, `no remaining task is eligible`, or a regression of a `sideEffect` task): stop, tell the person what it says and wait. They resume with `/pantheon flow resume` or end the flow with `/pantheon flow stop`.
   - **A held Stop** (`Pantheon flow: Task T (...) is not done: its checks fail`, `Regression: task T ...`, `Task T is not finished`, or a task still waiting for a receipt): fix it through the implementer or reviewer it names or, when its text says the attempts are spent, the architect with `[<taskId>]`; then stop again. `Waiting for N background task(s)` is not a block: wait for the notifications and start nothing that depends on them.
   - **A Stop ending `unverified`** (`Checks could not run, so their tasks are unverified ... Create the directory the check needs, or ask the person to fix the plan and approve it`, or the same wording on a task end): a check did not run because its `cwd` is missing or its command did not start. No attempt is spent and the task is not failed, so do not retry the implementer. Have the implementer create the directory (as its own task or within the task's files), or tell the person the plan's check must be fixed and approved again. Then stop again.
   - **A side-effect task paused with `ask_person`** (`is a side effect and its checks could not run ... check it by hand`): the effect may already have run, so never delegate it again. Stop, tell the person to check it by hand and wait: `/pantheon flow resume` marks the task done and starts what depends on it; `/pantheon flow stop` ends the flow.
   - **Never mark a task done yourself**, skip a check, or edit a task's files while it awaits a receipt (that voids the receipts); send the fix to the implementer. A task is done when the controller says so.
6. **Review only when asked.** Spawn a reviewer with `[<taskId>]` only while the controller says the task awaits it; other reviews go without the prefix.
   - **QA** (a task with `criteria`): brief it with the numbered criteria (C1, C2, ...), the task's commit and how to run it. It answers `C<n>: pass|fail — evidence` per criterion and a final `QA: pass|fail|blocked`, and never fixes anything. A `pass` counts only when every criterion has its own passing line; an answer the controller cannot read is no receipt.
   - **Architect** (a task with `risk: true`): the implementer has already committed, and a rejection lands as a follow-up commit. Before the gate, write down what changed, the validation evidence and the specific risk, then ask it to put its findings first and end with `REVIEW: pass` or `REVIEW: fail`; without that line there is no receipt. A gate is one review and at most two re-reviews, and a re-review happens only when the fix changed the reviewed decision or risk.
7. **Push.** Check the implementer's commit with `git log`. If it is missing, ask the implementer for it or commit the task's paths yourself. You push.

When the controller reports every required task done, use `finish`.

## Without a flow

1. **Brief.** From the task section and the interfaces it names, nothing else, as in With a flow, step 2.
2. **Dispatch.** `developer` writes the code, UI included; `ux` takes the tasks about look and feel (layout, hierarchy, color, spacing, motion, UI copy). Call its `pantheon:<role>` agent. Without a specialist, do the task yourself.
3. **Test first, check, push.** Test first and commit as in With a flow, step 4. Run the acceptance command yourself and read its output. Check the commit with `git log`; if it is missing, ask the implementer or commit the task's paths yourself. You push.

Run tasks in sequence. Run them together only when the plan marks `parallel: yes` and their files are disjoint; each implementer owns its files. Read-only lanes always run in parallel. Keep one implementer session per task when the role supports resume, and reuse it for fixes.

Retry the same implementer once with the error and the output. If it fails again, ask the architect to diagnose. If that does not resolve it, stop and ask the person.

Only tasks marked `risk: yes` go to the architect, under the gate of With a flow, step 6. Fix what the review found, then check again.

When every task is done, use `finish`.
