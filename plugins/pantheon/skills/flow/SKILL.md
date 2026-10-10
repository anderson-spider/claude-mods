---
name: flow
description: How to work inside a Pantheon flow. Use when a Pantheon flow context block or a "[Pantheon flow]" Stop instruction appears, when a task will take several steps and should be finished and verified, or when the person mentions flow.json, phases or claims.
---

# Working with the Pantheon flow

The flow tracks a session against `.pantheon/flow/flows/<id>/flow.json`: a goal and phases, each with a `done_when` sentence and often a shell `check`. When you try to stop, the Stop hook runs the checks, asks Jev (a calibrated judgment model) where the work is, and a fixed policy decides whether you may stop.

## Starting a flow

- For a task that will take several steps and should be finished and verified (not a question or a one-line change), call `mcp__pantheon__flow` with `{ "action": "start", "name": "<short-kebab-name>", "goal": "<the person's request, verbatim>" }` before writing any code, then follow what it returns: write the phases to the flow.json it names and check them with `{ "action": "validate" }`.
- The Stop is held until the flow is laid out (at most 3 times; then the draft is archived as abandoned).
- A finished flow moves to `.pantheon/flow/done/<id>/` with a SUMMARY.md, and the next task starts a new one.

## Claims: who works on which phase

- Each agent claims the phase it takes: `{ "action": "claim", "phase": "<phase id>", "as": "<role>" }`, where `role` is one of lead, code-reader, docs-reader, developer, ux, architect, qa. Claim before you start the phase; re-claim when you move to another, so the Flow tab of `/pantheon` stays accurate.
- When you delegate a phase to a role, tell the agent to claim it with its own role first. Pick a phase nobody claimed whose dependencies are done; phases with no dependency between them can run in parallel.
- Claims are advisory: the Stop policy never reads them.
- If a `[Pantheon flow]` note says other sessions are running flows in this folder and the request belongs to one of them, join it with `{ "action": "join", "flow": "<flow id>" }` before you start, then claim. Start your own flow for unrelated work. Never edit another flow's files.

## When a `[Pantheon flow]` instruction blocks your stop

- Treat it as the next instruction. Do the concrete thing it names for the named phase.
- If it quotes failing check output, fix the cause shown there. Run the check command yourself before claiming the phase is done.
- "You said the work is done, but it is not" means a check still fails. Do not repeat the claim; make the check pass.
- "You are looping" means your last approach is not working. Re-read the goal and change approach, not just parameters.
- "Regression" means a phase that was done now fails its check. Fix that first.
- Never edit `state.json` or `flow.json` under `.pantheon/flow/` to get past a block. Only the flow writes state. Changing the flow is the person's decision.
- `NEEDS_HUMAN.md` in the flow's folder means the flow decided a human must answer. Stop and surface the question; do not guess.

## Checking

- `{ "action": "status" }` or `/pantheon flow` shows the phase table, claims, recent decisions and any pending human question. The `/pantheon` panel's Flow tab shows the same live.

## What Jev sees

Goal, phase table, check results (with a tail of failing output), the tail of your last message, a change summary (file names and line counts only, unless the flow sets `privacy.send_diff`), and the last few decisions. Keep your final message of each turn a plain, honest summary of what was done and what still fails; that is what gets judged.

## Side effects

A phase marked `side_effect` (publish, send, deploy): do the action at most once, and check first whether a previous session already did it. Once it is recorded done, the flow never routes back into it; a failing check there asks a human.
