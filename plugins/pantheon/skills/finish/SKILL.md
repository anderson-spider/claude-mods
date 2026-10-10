---
name: finish
description: Use before claiming work is done, opening a PR or closing a branch. Needs the flow complete, runs the real validation, gets one review of the whole branch and opens the PR.
---

# Finish

1. **Flow.** If this session works on a flow, it must be complete: the Stop said `Goal complete` and archived it under `.pantheon/flow/done/`, or `mcp__pantheon__flow` status says `Done: yes`. If a required phase is still `pending` or `active`, or a human decision is pending, say which and why, then stop: no validation claim, no push, no PR. Go back to the phase, or surface the question in NEEDS_HUMAN.md. If every required phase passes its check but the flow is not done, it completes at the next Stop: end your turn, then run `finish` again. Without a flow, skip this step.
2. **Validate.** Run the project's real commands (tests, validation, lint, type checks) on the final state and read the output. Claim only what the output shows. Report failures with their output instead of saying they pass.
3. **Review.** Send the whole branch to the architect once: the diff against the base, the plan and the validation output. One review and at most two re-reviews, and a re-review only when the fix changed what was reviewed. Fix what is real, answer what is not.
4. **Close.** When the person asks or the project's rules say to open a PR/MR, you do it yourself: push the branch, squash by the `[<taskId>]` commit range only when the person asks or the project's rules say so, and open the PR/MR following the project's rules for commit messages, PR/MR titles and descriptions, labels and target branches. Validation and review stay with you. Remove the worktree only when they ask.
5. **Report.** Check your own commit SHAs and the PR/MR URL. State what was done, how it was validated and what is pending.
