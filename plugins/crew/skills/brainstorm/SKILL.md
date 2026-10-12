---
name: brainstorm
description: Plan multi-file changes, compare approaches or protect contracts with the crew before implementation. Use for planning, brainstorming or choosing a feature, refactor or fix approach.
---

# Brainstorm with the crew

Deliver a user-approved plan before implementation; leave source edits for the approved run. For a one-line change, rename, typo or known-answer question, delegate directly to `crew:developer` or answer.

## Plan

0. **Ignore output.** Agent artifacts live under `.crew/` at the repository root. Before writing, check `git check-ignore -q .crew`; if needed, append `.crew/` to the root `.gitignore` (create it if missing) and tell the user. Outside git, create the folder.
1. **Frame.** State the goal, constraints and acceptance criteria. Collect blocking questions in one `AskUserQuestion`; state conventional defaults for the rest.
2. **Gather in parallel.** In one message, send self-contained questions and starting files/terms to `crew:code-reader` for code evidence (`path:line`) and `crew:research` for sourced external facts. Use only the roles needed; spot-check claims before making them plan steps.
3. **Compare.** Present two or three options with costs and risks. For user-visible changes, first ask `crew:designer` for layout, states and copy, then include that spec.
4. **Challenge.** Send the leading option, goal and constraints to `crew:architect`, with `.crew/reviews/<name>.md` for its review. Ask about contracts, authentication, data shapes and project rules. Incorporate or answer every objection.
5. **Write the plan** to `.crew/plans/<name>.md`: context, chosen approach, files, existing code to reuse, verification and steps. Pass the path to every implementing or auditing agent. Use one line per step:

   `- <ID> (<owner>, after: <ids or —>) <action and files> — state: <state>[ (<note>)]`

   - ID: uppercase letters, digits and an optional lowercase suffix (`T3`, `T3b`).
   - Owner: `lead`, `crew:code-reader`, `crew:research`, `crew:designer`, `crew:developer`, `crew:architect` or a registered twin.
   - State: `queued`, `implementing`, `ready for QA`, `fixes requested`, `verified`, `blocked`, `committed`.

   Example: `- T3 (crew:developer, after: T1, T2) add the contract suite in tests/contract — state: queued`.

   End with `## Waves`: a numbered list of comma-separated step IDs, grouped by independent inputs and disjoint files. Keep only the chosen approach and options the user needed to weigh.
6. **Ask for approval.** The plan is the deliverable; implementation waits for approval. After approval, recommend a mode and command, then wait for the user to start it:
   - `/goal`: a verifiable end, using the plan's acceptance condition as goal text.
   - `/loop`: repeating or waiting work, with an interval.
   - Direct delegation to `crew:developer`: a few straightforward steps.

## Execute an approved plan

- Launch every ready independent piece in one message; relaunch newly unblocked work without being asked or waiting for unrelated agents. End each update with one line on what runs, what waits and on what.
- Start call descriptions with the step ID. Update step states in place.
- `crew:developer` implements, reproduces, adds/runs tests and reports exact commands/output. `crew:designer` owns UI specification and visual edits.
- A step is `verified` only after `crew:architect` or its registered twin independently audits the full diff against the plan, optionally rerunning tests. The developer's self-check is its report, not acceptance. The architect writes `.crew/reviews/<name>.md` and opens with `Approve`, `Fixes` or `Reject` and a one-line reason.
- Send failures to the same developer, including a `-codex` developer, with the criterion and expected versus actual; the architect reaudits after the fix.
- Mark a step `committed` when its code is committed. A code-free gate closes with the commit it gated, recording the SHA in its note.
- Agents use role defaults; with `jevKey` set, Jev may size model/effort one step from them. Explicit `model` bypasses routing on Claude roles. Call registered Codex twins without `model`: their fixed model must remain intact.
