---
name: finish
description: Use before claiming work is done, opening a PR or closing a branch. Needs the flow complete, runs the real validation, gets one review of the whole branch and opens the PR.
---

# Finish

1. **Flow.** If the plan has an approved flow, it must be complete: `/pantheon flow status` shows every required task done (ask the person to run it if you cannot see its output). If any task is pending, active, failed, paused or still awaiting a QA or architect receipt, say which and why, then stop: no validation claim, no push, no PR. Go back to `execute`, or ask the person to resume or end the flow. Without a flow, skip this step.
2. **Validate.** Run the project's real commands (tests, validation, lint, type checks) on the final state and read the output. Claim only what the output shows. Report failures with their output instead of saying they pass.
3. **Review.** Send the whole branch to the architect once: the diff against the base, the plan and the validation output. One review and at most two re-reviews, and a re-review only when the fix changed what was reviewed. Fix what is real, answer what is not.
4. **Close.** When the person asks or the project's rules say to open a PR/MR, push the branch yourself first (the lead pushes; `git` does not), then delegate to `pantheon:git`. Brief it with what to include, branch, base, squash yes/no (and the task's commit range if yes, taken from the `[<taskId>]` commits), PR/MR yes, and title/summary points. Follow the project's rules for commit messages, PR/MR titles and descriptions, labels and target branches. Validation and review stay with you. Remove the worktree only when they ask.
5. **Report.** Check the git report's commit SHAs and PR/MR URL. State what was done, how it was validated and what is pending.
