---
name: brainstorm
description: Plan a non-trivial change before implementing it, using the crew agents for each step. Use when the user asks to plan, brainstorm, design an approach or compare options for a feature, refactor or fix, and before delegating work to crew:developer.
---

# Brainstorm with the crew

Plan first, implement later. This skill produces a plan the user can approve; it does not edit code.

## When not to use

Skip it for a one-line change, a rename, a typo or a question with a known answer: go straight to `crew:developer` or answer directly. Use it when the change touches several files, has more than one reasonable approach, or can break a contract.

## Flow

0. **Keep the output out of git.** Everything the agents write goes in `.crew/` at the repository root. Before the first write, check `git check-ignore -q .crew`; when it is not ignored, append `.crew/` to the root `.gitignore` (create the file if missing) and tell the user in one line. Outside a git repository, just create the folder.
1. **Frame.** Restate the goal, the constraints and how success will be checked. Ask the user only what blocks the plan, in one `AskUserQuestion`; take the conventional default for the rest and say which you took.
2. **Gather, in parallel.** In one message, delegate the independent lookups:
   - `crew:code-reader` for where the code lives and how it works (answer as `path:line`).
   - `crew:research` for external facts: library docs, API behavior, release notes, with sources.
   Give each a self-contained question and the files or terms to start from. Skip an agent the task does not need.
3. **Diverge.** Write two or three options with what each costs and what each risks. For anything the user sees, ask `crew:designer` for a UI spec first (layout, states, copy) and include it in the options.
4. **Challenge.** Send the leading option to `crew:architect` with the goal and constraints (and the `.crew/reviews/<name>.md` path to write its review to), asking whether it preserves the invariants (contracts, auth, data shapes, project rules). Fold each objection into the plan or answer it in writing.
5. **Plan.** Write one plan: context, the chosen approach only, the files to change and the existing code to reuse, how it will be verified, and the steps. Every step is one list line: `- <ID> (<owner>, after: <ids or —>) <text> — state: <state>[ (<note>)]`, with the files it touches in the text. The ID is uppercase letters, digits and an optional lowercase suffix (`T3`, `T3b` for a follow-up); the owner is `lead` or a `crew:<role>` agent type. The state is one of `queued`, `implementing`, `ready for QA`, `fixes requested`, `verified`, `blocked`, `committed`. Example: `- T3 (crew:developer, after: T1, T2) add the contract suite in tests/contract — state: queued`. End with a `## Waves` heading and a numbered list, one wave per item with its step ids comma-separated: groups of steps with no dependency between them and no shared files, which run at the same time. Save it as `.crew/plans/<name>.md` and pass that path to every agent that implements, tests or audits it.

6. **Recommend how to run it.** Once the user approves, say which mode fits and give the command, then wait: starting it is the user's call.
   - `/goal` when the plan has a verifiable end (tests pass, a check is green, a file exists): offer the end condition from the plan as the goal text.
   - `/loop` when the work repeats or waits (watching CI, re-running until stable, babysitting a PR): offer an interval.
   - Neither when the plan is a few direct steps: delegate to `crew:developer` as is.

## Who does what after the plan

Run the plan by its waves: launch a whole wave in one message, and start a later step as soon as its own inputs are ready instead of waiting for the rest of the wave. Update each step's state in place in the plan file as work moves; a step is verified only after `crew:tester` or `crew:architect` has checked it, not on the developer's report. A step is `committed` once its code is in a commit; a step with no code of its own closes as `committed` with the commit it gated, the sha in the note (`— state: committed (<sha>)`). Start each agent call's description with the step id.

| Step | Agent |
| --- | --- |
| Implement | `crew:developer` |
| Specify or adjust the UI | `crew:designer` |
| Reproduce, cover with tests, run the suite; reports to `.crew/reviews/` | `crew:tester` |
| Audit the diff against the plan (writes the review to `.crew/reviews/<name>.md`) | `crew:architect` |

Each agent runs on its default model and effort; with Jev routing (on when the `jevKey` option is set), the model and effort of a call may move one step, so do not pass a `model` unless a specific one is needed (a call that names a model is not routed).

## Rules

- No edits during brainstorming; the plan is the deliverable.
- Treat every agent answer as unverified input: spot-check a claim before it becomes a step.
- Keep the plan short enough to scan; options the user did not need to weigh stay out.
- End by asking the user to approve the plan before any agent implements it; the run mode is a recommendation, never started on its own.
