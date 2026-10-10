# pantheon

Makes the main session an orchestrator in the style of oh-my-opencode-slim. The six roles and every council seat are native Claude subagents; the configuration chooses each one's model, effort and extra prompt.

IMPORTANT: prompts and panel modules include third-party work. Keep `LICENSE` and the credits and full license text in `NOTICE`.

## Roles

- Roles and seats are registered as native `pantheon:<role>` or `pantheon:councillor-<seat>` agents with `$.agent.register` (no tool list, so they inherit the session's tools; oracle and councillors get `disallowedTools` Edit, Write and NotebookEdit; explorer, librarian, oracle, git and councillors also get Agent; executor and designer get none), and hidden by an `agent.offer` guard when disabled.
- Executor implements code changes and runs scripts, test batteries and API calls within the brief, returning short results; no external research or sub-delegation. Commits and history operations stay with git.
- Executor, designer and git may write within their assigned scope. The git role executes commits, squash, push, PR/MR creation and repository state changes (checkout, switch, worktree, stash) from the orchestrator's brief; the orchestrator decides the included changes, branch, base, squash/push/PR choices and task commit range, and owns validation. Git follows repository conventions and templates, uses `gh` or `glab`, and reports SHAs, push results, PR/MR URLs and refusals.
- Git's fixed refusals cover modifying default or protected branches (including main/master/develop), unverified branch protection, force push without `--force-with-lease`, PR/MR merges, remote branch deletion, history rewrites outside an explicit task commit range, and work outside the task.

## Config

- `config.ts` merges built-in defaults, `~/.claude/pantheon.json` and `<repo>/.claude/pantheon.json` field by field: `agents.<role>` and `council.seats.<seat>` take `model`, `effort` and `prompt`; `disabledAgents` is a union. Models must be Claude models (`models.ts`).
- Fields of the Codex and profile era (`profile`, `profiles`, `sandboxCap`, `noNetwork`, `foregroundMinutes`, an entry's `engine` or `sandbox`) and the old `fixer` name fail to load with a message saying what to do.

## Edit gate

- `decisions.ts` is pure, with injected fetch and timer; it sends metadata only to the decision model through OpenRouter and falls back to local size and path rules. `gate.ts` is pure and builds edit context, exemptions and messages. Pure modules never touch `$`; `register.tsx` owns host access, path resolution, key lookup and the Proceed/Cancel hold.
- The `tool.call` hook matches `Edit`, `Write` and `NotebookEdit`, main session only. It is registered after the tracking handler, which wraps it and observes the settled result once: held calls are not counted early and denials do not count as successful edits.
- Plugin options: `gate` defaults to false; sensitive `jevApiKey` falls back to `OPENROUTER_API_KEY`. Score thresholds `0.85` (allow) and `0.30` (deny) are constants; the grey zone asks only when `session.start` reports `isInteractive: true` and a non-null `surface`, otherwise it denies without a hold. Recovery covers evaluation only; forwarding failures propagate to the engine without a second confirmation. No paths or contents cross the request boundary, only closed kind/extension classifications, tool, line counts, file count and the fixed caller label.
- Exemptions are `<repo>/.pantheon/**`, `~/.claude/plans/**`, `~/.claude/projects/*/memory/**` and the current user's session scratchpad; the rest of `~/.claude` is gated. Decisions are per call, with no per-turn accumulator or Bash write detection.

## Tracking and state

- `tracking.ts` holds pure reducers for native subagents and the main session, plus tool-input redaction.
- The tracking hooks (`turn.start`, `turn.step`, `turn.complete`, `session.measure`, `agent.spawn`, `tool.call`) only watch and pass events on unchanged.
- `pantheon.natives`, `pantheon.session` (with the ledger cost) and `pantheon.view` (the folded groups) live in `$.state`, written through queues that keep only the latest pending snapshot.
- The panel shows one toast per session the first time saving the panel state (agents, session or folded groups) fails.
- `register.tsx` builds host closures in each hook because `$` cannot be stored.

## Roster

`roster.ts` joins the native records of the six roles and council seats into eight fixed slots (orchestrator, explorer, librarian, executor, oracle, designer, git, council), with "other agents" when present. The panel groups them as Running (one row per live instance; each council seat has its own) and Idle (exactly one row per role and per council seat with nothing live: the latest run's model, duration and task, a strip of `▰` marks for the role's last four rounds (only with two or more rounds) with `+N` for older ones, `⊘` for a disabled one). A lost run counts as Idle. The council slot carries every configured seat in `seats`.

## Panel

The panel opens at session start. `/pantheon close` closes it; `config` shows the effective configuration and field origins. `doctor` checks the config and pings every role and seat (`ping.ts` plans the targets; `register.tsx` queues the session prompt that calls each agent with `io.after(0, …)`, because the host refuses `prompt.submit` while a `command.run` hook runs). There is no panel configuration.

- `pane.tsx` draws the Agents view only (no tabs).
- Desktop: segments in the former hud plugin's colors, pills as native round-bordered `Box`es (centered, border included in their width; the header's `N running` badge is one, with the close button spaced from it), a pulsing SMIL running dot (image `Svg`, in a fixed 1.5-column slot like the strip's) in the header, the session card and running agent rows, native text and buttons, fixed numeric slots, identity-first agent rows (the model column fits the longest model name, 11 to 24 cells; the terminal keeps 11), a card per section in a native rounded `Box` (colored border, sized to its content, no fixed height or SVG backplate, an even 1-row gap between cards and the same gap under the header when the body has 6 rows or more, and no fold button: a fold stored from the terminal is ignored there; row/column pixels are `ROW_PX` 19 and `COL_PX` 8), and a pane-width "Last 15 minutes" SVG timeline, then a "Session log" card built by `log.ts` from the roster (no hook or persisted state of its own).
- Docked and inline mini: bordered cards per section (colored border) and task-first rows; docked adds the animated rail, mini has none.
- `rail.tsx` and `elapsed.tsx` are surface modules for the animated rail (110 ms frames, only while there is active work) and live clocks. `theme.ts` holds the shared palette, section and role colors and cell helpers.

## Above-prompt strip

`hooks/strip/` holds the modules ported from the former hud plugin (Apache-2.0, built on Token Weather Usage; keep `NOTICE` and `LICENSE-APACHE`), drawn by the `AbovePrompt` entry in `register.tsx` as one rounded box (on desktop, `drawDesktopBox` in `box.ts`: one native `borderStyle="round"` `Box` of three rows, "HUD C": a session row with a pulsing SMIL dot and a ctx `Svg` bar, the 5h and 7d windows side by side (stacked below 66 inner columns), each a label, an exact-px `Svg` bar with a 1.5px elapsed-time tick, the percentage and pace mark, with the time left and the projection in dim text under the bar, and the last-turn or agents row under an `Svg` rule; the proportional font cannot line up glyph edges or space padding, so every column is a fixed-width `Box` and the lowest-priority session parts drop when narrow) or, on the terminal, of at most four rows (`box.ts`): session row, 5h and 7d rows (hud's 10-cell bar plus the `│` clock mark, the same 11 cells on both rows, columns padded to line up, then the projection from `pace.ts`: average rate, or the recent slope when it is 1.5 times faster), and a last row that is either the last-turn receipt (`receipt.ts`) or the running subagents folded in (`agents.ts`). Every width is counted in terminal cells with `theme.ts` (`⚡` takes two). `limitData.history` keeps about 10 `{at, used}` readings per window, saved with each session's readings in the strip store. The receipt counters are per-turn state reset at `turn.start`, fed by the existing `agent.spawn`, `tool.call` (main loop only, result read and passed on as it came) and `turn.complete` handlers; the cost comes from `cost.usd` in `session.measure` and `$.session.usage()`, so the turn's `+$` is the session cost delta during the turn (background agents' spend included), and the agents counted are those the main loop spawned (`!parentAgentId` with an `agentId` in the result), Workflow ones included. Pace readings are stamped with the reading's own time and kept with its `resetsAt`; a new `resetsAt` or a drop in use clears them. Options `abovePrompt` (default true, off hides the strip) and `paceStart`. The next-step suggestions were dropped with hud; users migrating run `/plugin uninstall hud`. Pure modules take host access injected and never touch `$`.

## Prompts and skills

- `prompts/` holds the orchestrator section, role prompts and Council Mode.
- `skills/` holds `grill`, `execute`, `debug` and `finish` (`<name>/SKILL.md`). `execute` and `finish` route commits, push and PR/MR creation to git from an orchestrator brief; validation and review remain with the orchestrator. `scripts/check-consistency.mjs` checks their frontmatter.
