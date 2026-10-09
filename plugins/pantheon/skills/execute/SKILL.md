---
name: execute
description: Use to carry out a written plan (for example one from grill). Dispatches each task to the fixer or designer with a brief built from the plan, runs the tests, commits, and sends only the risky tasks to the oracle.
---

# Execute

Run `.pantheon/plans/<plan>.md` task by task.

## Per task

1. **Brief.** Build it from the task section and the interfaces it names, nothing else: goal, files, interfaces, acceptance, and the rule below. Reference paths instead of pasting files.
2. **Dispatch.** The fixer implements; the designer takes UI work. Use the call each role has in the Agents section: `delegate` for a role on Codex, the `pantheon:<role>` agent for one on Claude. Without a specialist, do the task yourself.
3. **Test first.** Every brief tells the implementer to write a failing test for the acceptance criterion, then the code, then run the tests. It does not commit; absence of a commit is not a blocker.
4. **Check.** Run the acceptance command yourself and read its output.
5. **Commit.** You commit, only the files of the task, with a Conventional Commit message.

## Order

- Run tasks in sequence. Run them together only when the plan marks `parallel: yes` and their files are disjoint; each implementer owns its files.
- Read-only lanes (explorer, librarian) always run in parallel.
- Keep one implementer session per task when the role supports resume, and reuse it for fixes.

## When a task fails or blocks

Retry the same implementer once with the error and the output. If it fails again, ask the oracle to diagnose. If that does not resolve it, stop and ask the person.

## Review

Only tasks marked `risk: yes` go to the oracle. Before the gate, write down what changed, the validation evidence and the specific risk, so the oracle does not rediscover context. A gate is one review and at most two re-reviews, and a re-review happens only when the fix changed the reviewed decision or risk. Fix what the review found, then check again.

When every task is done, use `finish`.
