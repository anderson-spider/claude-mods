# Pantheon panel: absorb flightdeck into `/pantheon`

Date: 2026-10-08. Status: approved design, pending implementation plan.

## Goal

`/pantheon` becomes the dashboard of the Pantheon team: one place to watch every role, see when it is called and what it is working on, with flightdeck-style motion while work flows. The flightdeck plugin is removed; only its animation modules and its subagent tracking are ported. The visual reference is the first design round on the canvas "Painel do Pantheon" (artboards `Main`, `TerminalJobs`, `TerminalMini`, `Desktop`, `DesktopJobs`).

## Decisions

- Flightdeck is absorbed and removed from the marketplace. Its MIT credit moves to Pantheon's `NOTICE`.
- The panel is rewritten in Pantheon (approach 1). Ported from flightdeck: `rail.tsx`, `elapsed.tsx` and the native subagent tracking. Not ported: gate, loops, receipt, session log, architect timeline, layouts and every config option.
- No configuration: the panel always shows everything.
- The unit is the role. Seven fixed slots, always visible, in a fixed order: orchestrator, explorer, librarian, fixer, oracle, designer, council. Active roles do not move.
- Parallel instances of a role stack inside its slot. A resumed instance is the same line active again, showing its round.
- Non-Pantheon subagents (Explore, general-purpose and others) appear in one "other agents" line at the end, only when there is at least one.
- Rate limits, repository, branch, cache and suggested prompts stay in the hud plugin; the panel does not repeat them.
- The panel opens by itself at session start. `/pantheon close` closes it.
- User-facing text is in English.

## 1. Modules and data model

New or rewritten modules in `plugins/pantheon/hooks/`. Pure modules take what they need injected and never touch `$`.

| Module | Role |
| --- | --- |
| `tracking.ts` | Pure reducers for native subagent and main-session events. |
| `roster.ts` | Pure: joins Codex jobs, native records and config into the seven role slots plus "other agents". |
| `pane.tsx` | Rewritten: draws the Agents and Jobs tabs in the docked, mini and desktop layouts. |
| `rail.tsx`, `elapsed.tsx` | Surface modules ported from flightdeck. |

`register.tsx` gains the tracking hooks and keeps building an `Io` of closures in each hook.

New `$.state` keys, next to `pantheon.jobs`:

- `pantheon.natives`: one record per subagent: `id`, `role` (`oracle`, `designer`, `councillor-<seat>` or `other`), `type`, `task` (the spawn `description`), `model`, `rounds` (each with `startedAt`, `endedAt`, `status`), `ctx`, `out`, `steps`, `lastTool`. At most 24 records; the oldest leave first.
- `pantheon.session`: `model`, `effort`, `context` (`tokens`, `window`, `percent`), `isRunning`, `turnStartedAt`, `lastTurnMs`.
- `pantheon.view`: the selected tab (`agents` or `jobs`).

The types of these keys are declared in `plugins/pantheon/types/index.d.ts` next to `pantheon.jobs`.

How each slot is built:

- Codex roles (explorer, librarian, fixer, council seat alpha) come from `pantheon.jobs`. Jobs that share a `sessionId` are one line: a resumed job is created with the original job's `sessionId` (`hooks/jobs.ts`), so the line's rounds are those jobs in start order.
- Native roles (oracle, designer, council seat beta) come from `pantheon.natives`. A continuation through `SendMessage` reuses the `agentId` and adds a round. This is an assumption to confirm against the hooks API during planning; if the engine gives a continuation a new `agentId`, rounds for native roles are dropped and each continuation is a new line.
- A role is active when it has a running instance, off when it is in `disabledAgents`, and idle otherwise, with "last Xm ago" from its latest ended round.
- Council is one slot holding both seats. It is off when `council` is disabled or every seat is; a single disabled seat shows as off inside the slot while the other seat keeps its state.
- "delegating →" on the orchestrator card is derived from the active roles; it is not stored.

## 2. Events and data flow

Main session (`pantheon.session`):

| Hook | Effect |
| --- | --- |
| `turn.start` without `agentId` | `isRunning`, `turnStartedAt`. |
| `turn.complete` without `agentId` | `isRunning` false, `lastTurnMs`. |
| `turn.step` without `agentId` | `model`, `effort`. |
| `session.measure` | `context`. |

Native subagents (`pantheon.natives`):

| Hook | Effect |
| --- | --- |
| `agent.spawn` | New record with its role, task, model and first round. |
| `turn.step` with `agentId` | Adds the step's context and output tokens and one step. |
| `tool.call` with `agentId` | Stores the last tool as short text, for example `Read pantheon/hooks/jobs.ts`. |
| `turn.complete` with `agentId` | Closes the current round as done, failed or stopped. |
| `turn.start` with a known `agentId` | Opens the next round. |

Codex jobs keep their current flow and write queue.

Rules:

- Every tracking hook passes its event on unchanged (`return next(e)` or the result of `next`). Tracking only watches; it never blocks or changes a call.
- State writes go through a queue that keeps only the latest snapshot, as `pantheon.jobs` does today.
- On the module's first call after a start or reload, a native round still marked running becomes `lost`, as jobs do.
- A state read in an old or broken shape is normalized to its default; the panel draws what it can. A failed write shows one toast, as `persist` does today. Tracking errors never reach the user's call.

## 3. Drawing

Layout choice, with no configuration:

- Terminal pane (fullscreen): docked.
- `placement === 'inline'`: mini.
- `surface !== 'terminal'`: desktop.

Header (all layouts but mini): `PANTHEON`, the tabs `Agents` and `Jobs N` as Buttons (`tab` switches), and "N active · N idle · N off".

Agents tab, terminal docked:

- Orchestrator card with a light border: model and effort; turn state and clock; a context bar with tokens and percent; "delegating →" with each role in its engine's color.
- Active roles: a bordered Box with "● explorer ×2 · codex · gpt-6-luna · 2 running", then per instance an `├ └` tree line (id, task, clock), a `↳` line with the last activity, and a tokens line (`in · cached · out` for Codex, `ctx · out · steps` for native). With more than one round: an amber `↻ round N` tag and a rounds line with each round's duration.
- Idle roles: one line with a dim border, "○ librarian · idle · last 12m ago" (plus the resumable job id when there is one).
- Off roles: one line with a dashed border, "⊘ council · off · disabledAgents".
- "other agents" line at the end when present.
- Footer with the shortcuts.

Jobs tab: as the `TerminalJobs` artboard. Groups "active" and "finished", two lines per job, Cancel and Copy Buttons, `↻` when resumable, glyphs ● running, ◐ background, ✓ done, ✗ error, ⊘ cancelled, ? lost. Copy puts the job id and a resume hint on the clipboard.

Mini (at most 8 lines): one orchestrator line; one line per active role with its instances side by side, separated by `│`; one last line with idle and off roles and "/pantheon for details". More than six active roles collapse into "+N".

Desktop: the same tree with proportional type, engine color chips and cards, plus a "Last 15 minutes" card drawn with `Svg`: one lane per role, filled bars for running work, light outlined bars for finished work, rounds of one session joined by a dashed line, a "now" line and an "off" lane for disabled roles.

Colors: in the terminal, theme colors (blue for Codex, violet for Claude, green for running, amber for rounds, cyan for activity). On desktop, the hex values of the `Desktop` artboard.

Commands: `/pantheon` opens or focuses the panel, `/pantheon close` closes it; `cancel <jobId>`, `config` and `doctor` are unchanged.

## 4. Motion

Only what is working moves. Each animation redraws only its own region.

- Rail: each role has a short connector from the orchestrator column. While the role is active it lights in its engine's color and `●•` packets travel toward the role, one step every 110 ms, two packets per 24 cells. Idle roles have a dim static line; off roles have none. The connector between the orchestrator and the first role stays lit while a turn runs. `rail.tsx` is ported with two changes: the color comes from the engine and the connector can be drawn vertically or horizontally.
- Clocks: every active instance and the orchestrator's turn use the ported `elapsed.tsx`, which ticks every second and resyncs on each hook reading. A finished clock freezes at its final duration.
- State glyph: an active role's `●` alternates between bold and normal every 600 ms, inside the rail module. Idle is a static `○`.
- Docked: rails, clocks and the pulse. Mini: clocks and the pulse, no rails. Desktop: rails and clocks; the SVG timeline is static and advances on each hook redraw.
- Surface timers advance only while `active` is true. With nothing active, no frames are drawn.

## 5. Tests and flightdeck removal

Tests in `plugins/pantheon/tests/`, run by `claude plugin test plugins/pantheon`:

| File | Covers |
| --- | --- |
| `tracking.test.ts` | Spawn creates a record with the right role (`pantheon:oracle` → oracle, any other type → other); steps add tokens and steps; tool calls set the last tool; complete closes a round; a new `turn.start` for a known id opens the next round; the 24-record cap; `lost` after reload; old shapes normalize. |
| `roster.test.ts` | Seven slots always present in the fixed order; active, idle ("last Xm ago") and off; parallel instances stack; Codex jobs sharing a `sessionId` become one line with N rounds; "delegating →"; "other agents" only when present. |
| `pane.test.ts` (rewritten) | Rendering through the test host: Agents and Jobs tabs in docked, mini (`placement: 'inline'`) and desktop (`surface`); tab, Cancel and Copy Buttons; mini within 8 lines with "+N". |
| `rail.test.ts`, `elapsed.test.ts` | What `flightdeck.test.ts` covers of these modules today, plus the engine color and the pulse. |
| `register.test.ts` (extended) | Every tracking hook returns the event unchanged; queued writes land in order; the panel opens on `session.start`; `/pantheon close`. |

Flightdeck removal, in the same branch and pull request:

- Delete `plugins/flightdeck/` and its entry in `.claude-plugin/marketplace.json`.
- `plugins/pantheon/NOTICE`: credit `scasella/claude-flightdeck` 0.3.2 (MIT), include its license text, and list what was ported (rail, elapsed, subagent tracking) and how it was adapted.
- Update `README.md`, `AGENTS.md` (drop the flightdeck entry and the "seven plugins" count; describe the new panel under pantheon), `docs/VERIFICATION.md`, `docs/PRIVACY.md` and `plugins/pantheon/README.md` (the panel, and that flightdeck users should run `/plugin uninstall flightdeck`). `plugins/pantheon/docs/design.md` and `docs/plan.md` get a dated note only; they are history.
- Pantheon goes to 0.3.0.

Done means: `claude plugin validate plugins/pantheon` and `claude plugin test plugins/pantheon` pass, `make validate` passes, `node scripts/check-consistency.mjs` and `node scripts/check-version-bump.mjs origin/main` pass, and the panel is checked in a real session in the terminal and in the app while explorer and oracle run in parallel.

After the merge, on the user's machine: `make update` and `/plugin uninstall flightdeck`.

## Out of scope

- Permission gate, session log, model loops and the turn receipt.
- Rate limits, cost, repository, branch and cache (the hud plugin shows them).
- Any configuration of the panel.
