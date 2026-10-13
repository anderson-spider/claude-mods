# Route: change

- **Reuse before adding.** Search for the existing helper, type or pattern the change should extend; list what you reuse in the plan.
- **Blast radius.** Callers, tests, docs and anything shipped that needs a version bump. Name the test that covers each changed behavior.
- **Options.** Two or three approaches with their costs; recommend one and say why the others lose.
- **Deliverables.** One `### <deliverable>` per PR. Order steps by dependency; a step that only exists to satisfy another step's types or fixtures goes before it.
- **Scope.** Keep unrelated cleanup out; list it under the plan's notes when you notice it.

Acceptance: each step names the check that proves it, and the deliverable ends with its PR step.
