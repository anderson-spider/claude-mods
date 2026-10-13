# Route: contract

- **Name the invariants.** List each one the change touches (authentication, schema or wire shapes, read-only and guard rules, pinned prompt or message texts, shared constants) and where it is pinned: the test or the doc line.
- **Preserved or changed.** For each, say which. A changed invariant is updated with the change: its rule text and its pinning test move in the same deliverable.
- **Both sides together.** A contract with a producer and a consumer changes both, plus the test both halves compare, in one deliverable.
- **Challenge once.** When the risk is real, send `crew:challenger` the plan and this list, once. Take each objection into the plan or rebut it in a line; never gate on it.
- **Unverified.** Fakes and unit tests do not prove live behavior. Say what only a live run can show and mark it as pending, not as verified.

Acceptance: every invariant listed has its verdict and its pinning test is green or updated with the change.
