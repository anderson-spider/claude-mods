---
name: debug
description: Use on a bug, a failing test or unexpected behavior, before proposing a fix. Reproduces the problem, forms hypotheses and confirms the cause with evidence first.
---

# Debug

No fix before a confirmed cause.

1. **Reproduce.** Get the failing command, input or test and run it. If you cannot reproduce it, say so and ask for what is missing.
2. **Gather.** Read the error and the code on the path to it. Dispatch the explorer when the code is unfamiliar. Check recent changes.
3. **Hypothesize.** List the plausible causes, most likely first. Test each with the cheapest observation that can rule it out: a log, a print, a smaller input, a bisect.
4. **Confirm.** Name the cause and the evidence for it. If one pass does not find it, ask the oracle with the reproduction, what you ruled out and what you saw.
5. **Fix.** Write a test that fails for this cause, make the smallest change that fixes it, and run the test and the surrounding suite. Done: the new test and the suite pass. After three failed fixes, stop and question the approach with the person.
