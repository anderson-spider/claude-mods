---
name: brainstorm
description: Plan multi-file changes, compare approaches or protect contracts with the crew before implementation. Use for planning, brainstorming or choosing a feature, refactor or fix approach.
---

# Brainstorm with the crew

Deliver a user-approved plan before implementation; leave source edits for the approved run. For a one-line change, rename, typo or known-answer question, delegate directly to `crew:developer` or answer.

## Plan

0. **Ignore output.** Agent artifacts live under `.crew/` at the repository root. First create `.crew/` (or the subdirectory you need). Then run `git check-ignore -q .crew/`. Append `.crew/` to the root `.gitignore` (create it if missing) only when it exits 1, tell the user, and never add a duplicate line. On exit 0 do nothing; on exit 128 (outside git) only create the folder and never create a `.gitignore`.
1. **Frame.** State the goal, constraints and acceptance criteria. Collect blocking questions in one `AskUserQuestion`; state conventional defaults for the rest.
2. **Gather in parallel.** In one message, send self-contained questions and starting files/terms to `crew:code-reader` for code evidence (`path:line`) and `crew:research` for sourced external facts. Use only the roles needed; spot-check claims before making them plan steps.
3. **Compare.** Present two or three options with costs and risks. For user-visible changes, first ask `crew:designer` for layout, states and copy, then include that spec.
4. **Write the plan** to `.crew/plans/<name>.md`: context, chosen approach, files, existing code to reuse, verification and steps. Pass the path to every implementing or auditing agent. Inside `## Steps`, group steps under `### <deliverable>` headings (one per PR or related group). Use one line per step:

   `- <ID> (<owner>, after: <ids or —>) <action and files> — state: <state>[ (<note>)]`

   - ID: uppercase letters, digits and an optional lowercase suffix (`T3`, `T3b`).
   - Owner: `lead`, `crew:code-reader`, `crew:research`, `crew:designer`, `crew:developer`, `crew:architect` or a registered twin.
   - State: `queued`, `implementing`, `ready for QA`, `fixes requested`, `verified`, `blocked`, `committed`, `skipped`. `skipped` counts as closed.

   Example: `- T3 (crew:developer, after: T1, T2) add the contract suite in tests/contract — state: queued`.

   End with `## Waves`: a numbered list of comma-separated step IDs, grouped by independent inputs and disjoint files. Keep only the chosen approach and options the user needed to weigh.
5. **Ask for approval.** The plan is the deliverable; implementation waits for approval. After approval, recommend a mode and command, then wait for the user to start it:
   - `/goal`: a verifiable end, using the plan's acceptance condition as goal text.
   - `/loop`: repeating or waiting work, with an interval.
   - Direct delegation to `crew:developer`: a few straightforward steps.

## Execute an approved plan

- Launch every ready independent piece in one message; relaunch newly unblocked work without being asked or waiting for unrelated agents. End each update with one line on what runs, what waits and on what.
- Start call descriptions with the step ID. The lead updates each step's `state:` in place as soon as it changes; the crew HUD reads the plan file.
- `crew:developer` implements, reproduces, adds/runs tests and reports exact commands/output. `crew:designer` owns UI specification and visual edits.
- A step is `verified` only after `crew:architect` or its registered twin independently audits the full diff against the plan, optionally rerunning tests. The developer runs its own checks and reports the commands and output as evidence; that is its report, not acceptance. The architect audit is the acceptance. Request a separate independent reproduction only for behavior that needs it (auth, routing, or live checks against the real host or service), not for every step. That reproduction comes from a fresh `crew:developer`, not the implementer, or from `/live-test`, and the step closes only after it passes. The architect writes `.crew/reviews/<name>.md` and opens with `Approve`, `Fixes` or `Reject` and a one-line reason.
- Send failures to the same developer, including a `-codex` developer, with the criterion and expected versus actual; the architect reaudits after the fix.
- Mark a step `committed` when its code is committed. A code-free gate closes with the commit it gated, recording the SHA in its note.
- Models use role defaults or fixed twin ids; with `jevKey` set, Jev sizes effort only. Any Jev request or config failure requests medium; an agent past its first sent step keeps its effort. Explicit `model` bypasses routing on Claude roles. Call registered Codex twins without `model`: their fixed model must remain intact.
