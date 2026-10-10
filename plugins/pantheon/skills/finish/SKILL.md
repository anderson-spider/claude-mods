---
name: finish
description: Use before claiming work is done, opening a PR or closing a branch. Needs the flow complete, runs the real validation, gets one review of the whole branch and opens the PR.
---

# Finish

1. **Flow.** If the plan has an approved flow, it must be complete: `/pantheon flow status` shows `State: done` and every required task `done` (ask the person to run it if you cannot see its output; `onFail` branch tasks that never ran stay `pending` and do not count). If a required task is `pending`, `active` or `failed`, still `awaiting qa` or `awaiting architect`, or the state is `paused` or `stopped`, say which and why, then stop: no validation claim, no push, no PR. Go back to `execute`, or ask the person to run `/pantheon flow resume` or `/pantheon flow stop`. If every required task is `done` but the state is still `running`, the flow completes at the next Stop, which runs every task's checks: end your turn, then run `finish` again. Without a flow, skip this step.
2. **Validate.** Run the project's real commands (tests, validation, lint, type checks) on the final state and read the output. Claim only what the output shows. Report failures with their output instead of saying they pass.
3. **Review.** Send the whole branch to the architect once: the diff against the base, the plan and the validation output. One review and at most two re-reviews, and a re-review only when the fix changed what was reviewed. Fix what is real, answer what is not.
4. **Close.** When the person asks or the project's rules say to open a PR/MR, you do it yourself: push the branch, squash by the `[<taskId>]` commit range only when the person asks or the project's rules say so, and open the PR/MR following the project's rules for commit messages, PR/MR titles and descriptions, labels and target branches. Validation and review stay with you. Remove the worktree only when they ask.
5. **Report.** Check your own commit SHAs and the PR/MR URL. State what was done, how it was validated and what is pending.
