# Review

## A delegated delivery

Main reads its real diff against the brief and checks for:

- scope creep, and changes listed under Out of scope;
- missing parts and silent assumptions;
- deviations from the decided design;
- unhandled edge cases and error paths, broken invariants, regressions in neighbouring code;
- missing verification, and tests that pass by construction: an expected value recomputed the way the code computes it, mocks of the project's own modules, assertions on call counts or order.

A question the delegate leaves open comes back answered in the return brief: a visual question decided by Main, a product or scope question by the user when the request does not settle it.

## The reviewer's brief

- The requirements: the user's request, the plan's acceptance criteria and the spec when there is one.
- The diff against its base and the check results.
- The files where the project documents its coding rules: `CODING_STANDARDS.md` and `CONTRIBUTING.md` whenever they exist, plus the `AGENTS.md` or `CLAUDE.md` rules for the area.
- This file's path, for the smells below.

## Smells

The reviewer reports a smell the diff introduces as an optional Standards finding, labelled "possible <smell>" with the hunk and the fix below. A project rule that allows what it flags drops it, and so does a check the project's tooling already runs.

- **Duplicated Code**: the same logic in more than one hunk or file. Fix: extract the shared shape and call it from both.
- **Mysterious Name**: a name that does not say what it does or holds. Fix: rename it; when no honest name comes, the design is unclear.
- **Speculative Generality**: abstraction, parameters or hooks for needs the requirements do not have. Fix: inline it until a real need shows.
- **Shotgun Surgery**: one logical change scattered across many files. Fix: gather what changes together into one module.
- **Feature Envy**: a function that uses another object's data more than its own. Fix: move it next to that data.
- **Data Clumps**: the same few fields or parameters travelling together. Fix: bundle them into one type.
- **Primitive Obsession**: a primitive or string standing for a domain concept. Fix: give the concept its own small type.
