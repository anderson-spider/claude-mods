---
name: goal
description: Use when the person runs /pantheon:goal, or asks to start a tracked flow for an idea that is already defined (after a brainstorm, or in their own words). Starts the flow, lays out its phases with checks and begins the first phase.
---

# Goal

Start the Pantheon flow for one goal and track the work against it until the Stop allows it.

## 1. Check the session

- Call `mcp__pantheon__flow` with `{ "action": "status" }`. If it shows an active flow this session works on, say which one (its id) and stop. Do not start a second flow; `/pantheon flow` shows it.

## 2. Get the goal

- If the person wrote a goal after `/pantheon:goal`, use it verbatim.
- Otherwise use the idea defined in this conversation (from a brainstorm, if there was one) in one or two concrete sentences, the person's words where possible.
- If no idea is defined yet, ask the person for the goal in one question and stop.

## 3. Start the flow

- Call `mcp__pantheon__flow` with `{ "action": "start", "name": "<2 to 5 word kebab-case name>", "goal": "<the goal>" }`. It creates the draft bound to this session and returns the planning instructions. Follow them.
- If `start` answers "Flow not started", Jev has no key: pass that message on to the person and stop. Do not lay out phases or work around it.
- Write the phases to the flow.json the instructions name. If a brainstorm defined the idea, turn its decisions into the phases and their checks. Each phase has a `done_when` and, wherever one exists, a shell `check` that exits 0 only when the phase is really done.
- Check the layout with `{ "action": "validate" }`.
- Claim the first phase with `{ "action": "claim", "phase": "<phase id>", "as": "lead" }`, then start it. The Stop is held until the flow is laid out.
