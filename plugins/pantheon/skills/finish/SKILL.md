---
name: finish
description: Use before claiming work is done, opening a PR or closing a branch. Runs the real validation, gets one review of the whole branch and opens the PR.
---

# Finish

1. **Validate.** Run the project's real commands (tests, validation, lint, type checks) on the final state and read the output. Claim only what the output shows. Report failures with their output instead of saying they pass.
2. **Review.** Send the whole branch to the oracle once: the diff against the base, the plan and the validation output. One review and at most two re-reviews, and a re-review only when the fix changed what was reviewed. Fix what is real, answer what is not.
3. **Close.** Follow the project's own rules for the commit message, the PR title and description, labels and the target branch. Open the PR when the person asks. Remove the worktree only when they ask.
4. **Report.** State what was done, how it was validated and what is pending.
