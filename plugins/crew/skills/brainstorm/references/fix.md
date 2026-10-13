# Route: fix

- **Reproduce first.** A failing test or a command that shows the bug. When it cannot be reproduced, say so in the plan and state what evidence stands in for it.
- **Root cause, not symptom.** Name the condition and its `path:line`. A plan that patches where the symptom shows, without the cause, is not done.
- **Regression test.** The first step adds a test that fails for the cause; the fix step turns it green. When no test can reach it, say why and name the check used instead.
- **Neighbors.** List the callers and tests that share the changed code and run them.
- **Stop rule.** When the same test or compile error fails twice, stop varying the fix and re-check the cause before a third try.

Acceptance: the reproduction passes, the regression test exists and the neighbors still pass.
