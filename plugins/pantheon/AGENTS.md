# pantheon

Makes the main session an orchestrator in the style of oh-my-opencode-slim. Profiles (`claude` by default, `codex`, `mixed`, or custom profiles) choose the engine, model and effort for each of the five roles and every council seat.

IMPORTANT: prompts and panel modules include third-party work. Keep `LICENSE` and the credits and full license text in `NOTICE`.

## Engines and roles

- Roles and seats on Codex run through `delegate`, `delegate_result` and `delegate_cancel` on `codex exec --json`.
- Roles and seats on Claude are registered as native `pantheon:<role>` or `pantheon:councillor-<seat>` agents with `$.agent.register` (no tool list, so they inherit the session's tools; oracle and councillors get `disallowedTools` Edit, Write and NotebookEdit; explorer, librarian, oracle and councillors also get Agent, `mcp__pantheon__delegate` and `mcp__pantheon__delegate_cancel`; fixer and designer get none), and hidden by an `agent.offer` guard when disabled or moved to Codex.
- `codex.ts` builds argv and parses JSONL.
- `jobs.ts` runs foreground and background jobs and prompts the session when one ends.
- `roles.ts` and `workspace.ts` resolve the role, sandbox and `cwd` inside the repository root by `realPath`.

## Config and profiles

- `config.ts` resolves built-in, `~/.claude/pantheon.json` and `<repo>/.claude/pantheon.json` layers. Top-level `profile` selects the profile, `profiles` holds engine/model/effort, and prompts and sandbox settings stay at the top level.
- The project selection overrides the user selection, and the `/config` selection overrides both. `sandboxCap` and `noNetwork` merge to the most restrictive, and Codex role sandboxes can only narrow from their defaults.
- Legacy engine/model/effort fields under top-level roles and seats are rejected with migration paths. A top-level `model` stays an unknown field.
- `models.ts` validates engine/model pairs across every merged profile.
- The active profile is also a `userConfig` field (`pantheon.profile`, shown in `/config`). `register` passes a non-empty `options.profile` to `loadConfig`, applied after the JSON layers so it overrides their `profile` (origin `settings`); the field has no default, so unset means the JSON layers decide. A `config.set` hook refuses names outside the profiles the JSON layers define, and any change while the JSON is invalid. The panel selector (`pane.tsx`, locked only while a JSON layer sets `profile` and `/config` has none) calls `$.config.set` on the same field.

## Tracking and state

- `tracking.ts` holds pure reducers for native subagents and the main session, plus tool-input redaction.
- The tracking hooks (`turn.start`, `turn.step`, `turn.complete`, `session.measure`, `agent.spawn`, `tool.call`) only watch and pass events on unchanged.
- `pantheon.natives`, `pantheon.session` (with the ledger cost) and `pantheon.view` (the folded groups) join `pantheon.jobs` in `$.state`, written through queues that keep only the latest pending snapshot.
- The panel shows one toast per session the first time saving the panel state (agents, session or folded groups) fails. Jobs keep their own warning.
- `register.tsx` builds host closures in each hook because `$` cannot be stored.

## Roster

`roster.ts` joins all five roles on either engine and council seats into seven fixed slots (orchestrator, explorer, librarian, fixer, oracle, designer, council), with "other agents" when present. Slot engines follow the effective config and show `mixed` when an active instance or the latest ended one used a different engine. The panel groups them as Running (one row per live instance; each council seat has its own) and Idle (exactly one row per role and per council seat with nothing live: the latest run's model, duration and task, a strip of `▰` marks for the role's last four rounds (only with two or more rounds) with `+N` for older ones, `⇄` for a mixed engine, `⊘` for a disabled one). A lost run counts as Idle. The council slot carries every configured seat in `seats`.

## Panel

The panel opens at session start. `/pantheon close` closes it; `cancel <jobId>`, and `config` keep their existing behavior. `doctor` also pings every role and seat (`ping.ts` plans the targets and formats the section; `register.tsx` runs the Codex pings and queues the session prompt for the native ones with `io.after(0, …)`, because the host refuses `prompt.submit` while a `command.run` hook runs). There is no panel configuration.

- `pane.tsx` draws the Agents view only (no tabs); a running Codex row carries Cancel, wired to the instance's `jobId`.
- Desktop: segments in the former hud plugin's colors, pills as native round-bordered `Box`es (centered, border included in their width; the header's `N running` badge is one, with the close button spaced from it), a pulsing SMIL running dot (interactive `Svg`) in the header, the session card and running agent rows, native text and buttons, fixed numeric slots, identity-first agent rows, a card per section in a native rounded `Box` (colored border, sized to its content, no fixed height or SVG backplate, an even 0.6-row gap between cards and a small gap under each title row so the Collapse pill has room; row/column pixels are `ROW_PX` 19 and `COL_PX` 8), and a pane-width "Last 15 minutes" SVG timeline, then a "Session log" card built by `log.ts` from the roster (no hook or persisted state of its own).
- Docked and inline mini: bordered cards per section (colored border) and task-first rows; docked adds the animated rail, mini has none.
- `rail.tsx` and `elapsed.tsx` are surface modules for the animated rail (110 ms frames, only while there is active work) and live clocks. `theme.ts` holds the shared palette, section and role colors and cell helpers.

## Above-prompt strip

`hooks/strip/` holds the modules ported from the former hud plugin (Apache-2.0, built on Token Weather Usage; keep `NOTICE` and `LICENSE-APACHE`), drawn by the `AbovePrompt` entry in `register.tsx` as one rounded box (on desktop, `drawDesktopBox` in `box.ts`: one native `borderStyle="round"` `Box` of three rows, "HUD C": a session row with a pulsing SMIL dot and a ctx `Svg` bar, the 5h and 7d windows side by side (stacked below 66 inner columns), each a label, an exact-px `Svg` bar with a 1.5px elapsed-time tick, the percentage and pace mark, with the time left and the projection in dim text under the bar, and the last-turn or agents row under an `Svg` rule; the proportional font cannot line up glyph edges or space padding, so every column is a fixed-width `Box` and the lowest-priority session parts drop when narrow) or, on the terminal, of at most four rows (`box.ts`): session row, 5h and 7d rows (hud's 10-cell bar plus the `│` clock mark, the same 11 cells on both rows, columns padded to line up, then the projection from `pace.ts`: average rate, or the recent slope when it is 1.5 times faster), and a last row that is either the last-turn receipt (`receipt.ts`) or the running jobs and natives folded in (`agents.ts`). Every width is counted in terminal cells with `theme.ts` (`⚡` takes two). `limitData.history` keeps about 10 `{at, used}` readings per window, saved with each session's readings in the strip store. The receipt counters are per-turn state reset at `turn.start`, fed by the existing `agent.spawn`, `tool.call` (main loop only, result read and passed on as it came) and `turn.complete` handlers; the cost comes from `cost.usd` in `session.measure` and `$.session.usage()`, so the turn's `+$` is the session cost delta during the turn (background agents' spend included), and the agents counted are those the main loop spawned (`!parentAgentId` with an `agentId` in the result), Workflow ones included. Pace readings are stamped with the reading's own time and kept with its `resetsAt`; a new `resetsAt` or a drop in use clears them. Options `abovePrompt` (default true, off hides the strip) and `paceStart`. The next-step suggestions were dropped with hud; users migrating run `/plugin uninstall hud`. Pure modules take host access injected and never touch `$`.

## Prompts and skills

- `prompts/` holds the orchestrator section, role prompts and Council Mode.
- `skills/` holds `grill`, `execute`, `debug` and `finish` (`<name>/SKILL.md`). `scripts/check-consistency.mjs` checks their frontmatter.
