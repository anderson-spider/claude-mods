---
name: finish
description: Use before claiming work is done, opening a PR or closing a branch. Runs the real validation, gets one review of the whole branch and opens the PR.
---

# Finish

1. **Validate.** Run the project's real commands (tests, validation, lint, type checks) on the final state and read the output. Claim only what the output shows. Report failures with their output instead of saying they pass.
2. **Review.** Send the whole branch to the oracle once: the diff against the base, the plan and the validation output. One review and at most two re-reviews, and a re-review only when the fix changed what was reviewed. Fix what is real, answer what is not.
3. **Close.** When the person asks or the project's rules say to open a PR/MR, delegate to `git` (`delegate` on Codex, `pantheon:git` on Claude). Brief it with what to include, branch, base, squash yes/no (and the task's commit range if yes), push yes, PR/MR yes, and title/summary points. Follow the project's rules for commit messages, PR/MR titles and descriptions, labels and target branches. Validation and review stay with you. Remove the worktree only when they ask.
4. **Report.** Check the git report's commit SHAs and PR/MR URL. State what was done, how it was validated and what is pending.
