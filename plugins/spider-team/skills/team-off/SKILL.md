---
name: team-off
description: Close team mode opened by /spider-team:team-on - finish or cancel the open tasks, verify the integrated result and report the whole session.
disable-model-invocation: true
argument-hint: "[what to do with open tasks]"
---

# spider-team: team-off

Arguments: $ARGUMENTS

Close team mode, opened in this conversation by `/spider-team:team-on`. With none open, say so in one line and stop. You are still **Main** and its rules from `team-on` hold until this ends.

1. **Open tasks.** Finish or cancel each task that is not accepted, failed or cancelled, as the arguments say; when they say nothing and tasks are open, ask in one line which to finish. A cancelled task is reported as `{ task: { id, state: "cancelled" } }`.
2. **Verify.** Run the project's full checks (tests, types, lint, build, its own validation) on the integrated result and read the output. Fix each failure, or report it with its output.
3. **Complete.** Publish `{ finished: true }`, then report for the whole session: what was delivered, which tasks you and each role ran, what was verified and how, and anything left open.

Publish with the tool `mcp__spider-team__progress` when it exists (load it with ToolSearch if it is deferred); when it does not, skip reporting. After this, later messages are ordinary conversation again.
