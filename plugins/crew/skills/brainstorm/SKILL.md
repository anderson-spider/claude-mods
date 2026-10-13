---
name: brainstorm
description: Plan multi-file changes, fixes or contract changes before implementation: routes the request, compares approaches and protects invariants. Use for planning, brainstorming or choosing a feature, refactor or fix approach; the main session plans and implements, calling the planner, challenger or digger helpers only when they add value.
---

# Brainstorm

Deliver a user-approved plan before implementing. The main session does every step itself; a helper is a tool it may use, never a required stage.

## Route

Classify the request first and ask only what would change the route. Take one route; combine two only when the request needs both. The route sets how deep the plan goes, never who does the work.

| Route | When | Do |
| --- | --- | --- |
| question | asks how or why; no change wanted | answer; no plan |
| small | one-line change, rename, typo, known fix | do it; no plan |
| fix | a bug or a failing test | plan below, with `references/fix.md` |
| change | a feature or refactor over several files | plan below, with `references/change.md` |
| contract | touches auth, a schema, an API or wire shape, a guard, a pinned text or another invariant | the change route plus `references/contract.md` |

Read a route's reference only when the route is taken. State the route and its reason in one line before the plan.

## Plan

0. **Ignore output.** Plans live under `.crew/plans/` at the repository root. Create the folder, then run `git check-ignore -q .crew/`. Exit 1: append `.crew/` to the root `.gitignore` (create it if missing), once, and tell the user. Exit 0: nothing more. Exit 128 (outside git): the folder alone, no `.gitignore`.
1. **Frame.** State the goal, constraints and acceptance criteria. Collect blocking questions in one `AskUserQuestion`; state conventional defaults for the rest.
2. **Investigate.** Read what you need yourself. When a question is independent and costly to answer inline (another module, git history, external docs), ask `crew:digger`; send several diggers in one message only for independent questions. Spot-check a claim before a step rests on it.
3. **Compare.** Present two or three options with costs and risks. For complex or ambiguous work, `crew:planner` may draft the plan; it returns steps already in the line format of step 4, which you check against the code before using. For a decision with real risk, `crew:challenger` may question it once. Skip both when the answer is clear.
4. **Write the plan** to `.crew/plans/<name>.md`: context, chosen approach, files, existing code to reuse, verification (what each check proves and what it cannot, such as live behavior) and steps. Mark every assumption you could not confirm. Inside `## Steps`, group steps under `### <deliverable>` headings, one per PR (the HUD shows each heading as a deliverable). Use one line per step:

   `- <ID> (<owner>, after: <ids or —>) <action and files> — state: <state>[ (<note>)]`

   - ID: uppercase letters, digits and an optional lowercase suffix (`T3`, `T3b`).
   - Owner: `main` for the main session, which implements; `crew:planner`, `crew:challenger`, `crew:digger` or a registered twin only for a step that is a helper's question.
   - State: `queued`, `implementing`, `verified`, `blocked`, `committed`, `skipped`. `skipped` counts as closed; `verified` means the main session checked the step's acceptance.

   Example: `- T3 (main, after: T1, T2) add the contract suite in tests/contract — state: queued`.
   End a deliverable with its PR step: `- P1 (main, after: T3) review the full diff, commit and open the PR — state: queued`. It is `committed` once the PR is open.
5. **Ask for approval.** The plan is the deliverable; implementation waits for approval. After approval, implement it, or recommend `/goal` (a verifiable end, using the plan's acceptance condition) or `/loop` (repeating or waiting work) when they fit.

## Execute an approved plan

- The main session implements each step, runs its tests and fixes failures; consecutive steps need no subagent.
- Update each step's `state:` in place as soon as it changes; the crew HUD reads the plan file. A helper call for a step starts its description with the step id.
- Before the PR, review the full diff yourself against the plan: what changed, what is missing, hidden regressions, project rules and the tests that cover the change. Call `crew:challenger` only when an independent challenge of a risky change adds real value.
- Models use role defaults or fixed twin ids; with `jevKey` set, Jev sizes a helper call's effort only. Call registered Codex twins without `model`: their fixed model must remain intact.
