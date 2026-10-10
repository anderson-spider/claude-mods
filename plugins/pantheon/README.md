# Pantheon

A Claude Code mod in the style of [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim): the main Claude session is the lead and delegates to specialists, each a native Claude subagent. The configuration chooses each role's and council seat's model and effort.

## Install

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install pantheon@spider-claude-mods
```

`/pantheon doctor` checks the configuration and pings every role and council seat by asking the session, after the report, to call each `pantheon:*` agent, so they show as `pending` in the report. Disabled roles and seats show as `off`.

## Roles

| Role or seat | Default model |
| --- | --- |
| code-reader | `haiku` |
| docs-reader | `haiku` |
| developer | `sonnet` |
| architect | `opus` |
| qa | `sonnet` |
| ux | `sonnet` |
| seat alpha | `opus` |
| seat beta | `sonnet` |

The lead calls a role with `Agent({ subagent_type: "pantheon:<role>", prompt })` and a seat with `pantheon:councillor-<seat>`.

The lead gets a system prompt section, adapted from the slim `orchestrator.ts`, that says when to delegate, how to parallelize and how to call each role. A disabled role leaves that section and the Agent tool.

The `code-reader` role maps the codebase and returns compressed context. The `docs-reader` role reads external documentation and research and does not write docs. The `architect` role covers architecture, debugging, code review and simplification, read-only.

The `qa` role runs what was built (commands and tests, the app, a herdr pane when one is available, error paths) and returns a verdict per acceptance criterion, `C<n>: pass|fail — <evidence>` lines and a final `QA: pass|fail`; partial coverage is a fail. It never fixes code, never runs side effects (deploy, publish, push, migrations against shared data) and writes only in the session scratchpad, through Bash: Edit, Write, NotebookEdit and Agent are withheld. The lead routes acceptance criteria verification to it.

The `developer` role writes all the code (backend, scripts, tests, hooks, CLI, UI code and logic) and runs scripts, test batteries and API calls within the lead’s brief, returning short results (status, tables or errors). It does no external research or sub-delegation. When a task is about look and feel it tells the lead that it belongs to `ux`, as guidance, not a refusal. Once its checks (or its own validation) pass, it commits only its task's files with explicit paths (`git add -- <paths>`, then `git commit -- <paths>` with the task id in the message), never with `-A`, `.`, `--no-verify` or `--amend`, and never pushes, rebases, resets, merges, switches branches or stashes. The lead pushes.

The `ux` role owns the look and feel (layout, hierarchy, color, spacing, motion, affordances and UI copy) and implements it in whichever files its brief or task assigns. When the direction is open it first makes mockups (text for terminal UI, throwaway HTML prototypes in the scratchpad for web or desktop UI, never committed) and offers two or three directions; it implements the chosen one, with the design criteria (typography, color, motion, composition) and UI review. It commits its own task like `developer`. The split between the two is by kind of work, not by file extension.

The lead commits its own work and is the only actor that pushes, squashes and opens PRs/MRs, itself, following the project's rules: squash only when you ask or the rules say so, no force push without `--force-with-lease`, no remote branch deletion, no `--mirror`, and never main, master, develop, release or release/*. There is no git agent and no gate over git commands; your own deny rules and the server's branch protection are the boundary.

### Commands

- `/pantheon` opens or focuses the panel, which also opens by itself at session start.
- `/pantheon close` closes the panel.
- `/pantheon config` (effective config, where each field came from, current error) and `/pantheon doctor`.
- `/pantheon flow` shows the flow's status: phases, claims, budgets, recent decisions and any pending human question.

## Panel

The panel keeps eight role slots in order: lead, code-reader, docs-reader, developer, architect, qa, ux and council. Running lists one row per live instance (parallel runs each get a row, and each council seat has its own); Idle lists exactly one row per role and council seat with nothing live, showing the latest run's model, duration and task plus a strip of `▰` marks for the role's last four rounds, shown only from two rounds on (green done, red failed, `+N` for older ones). Disabled roles and seats show as `⊘` rows, and a lost run counts as Idle. Groups fold to their headings when the pane is short. Other native subagents appear under "other agents" when present. Running rows show model, elapsed time, context use and last activity; roles that never ran leave the time and task blank and keep their role color; when a role last ran shows in the timeline and the mini view. A "Session log" card at the bottom lists the last eight events (round started, done, failed, lost or stopped, disabled roles) with the time and the role in its color; end lines name the task, so parallel runs of one role stay apart; it is the first card to drop when the pane is short. The lead shows its model, effort, turn clock, context and the roles it is delegating to.

The desktop panel follows the former hud plugin's dark palette, tinted segments and 6px corners. The header, session card, agent groups and timeline share a 24px inset; the timeline follows the available pane width. Cost, Tokens and Time are horizontal segments below the session card, with fixed numeric slots (9, 7 and 6 cells); they wrap on narrow panes and become plain label/value rows when an individual segment cannot fit, stacking the value below the label at the smallest widths. Cost comes from the host's ledger and reads `—` until a measurement arrives. Tokens adds each agent's context or input and output, so it is a rough size, not a bill. Collapsible Running and Idle groups use full-width hairline separators. Each desktop row leads with role and model, followed by the task and readings; its state marker has a fixed slot. Planned text uses the readable secondary color. Native text and buttons sit over static SVG backgrounds, so they remain selectable and actionable.

The terminal panel draws one bordered card per section, each with its own border color, task-first rows, context progress bars and one-line Cost, Tokens and Time readings. Its close button appears from 58 columns. A rail animates at 110 ms only while an agent has active work, and clocks tick live.


The footer reads `keys: esc close`. The header shows `working` while only the main session runs, and the running-agent count when roles are active.

The terminal panel docks beside the transcript and uses a mini view when placed inline. Desktop adds a "Last 15 minutes" SVG timeline with a lane per role. The lead lane draws completed turns in gray and the current running turn in white; completed turns are retained for 15 minutes, up to 50 entries. The docked and mini layouts have clocks and steady text dots on running rows; desktop has clocks and steady SVG image dots. The timeline is computed once per draw and advances in 15-second steps. A run shorter than one step still draws one step wide. Inactive timers pause. The panel has no configuration.

The tracking hooks only watch and pass events on unchanged. Native records, main-session readings and the folded groups are saved in session state through queues that keep only the latest pending snapshot. The panel shows one toast per session the first time saving the panel state (agents, session or folded groups) fails; jobs keep their own warning. See [Privacy and permissions](../../docs/PRIVACY.md#pantheon) for the stored fields and tool-input redaction.

## Above-prompt strip

Since 0.13.0 pantheon draws an always-on strip above the prompt, absorbed from the former hud plugin:

A rounded box in flightdeck's mini style, at most four rows, kept next to the prompt:

- Session row: model and effort, working or idle, the context as a gauge with its percentage, the prompt cache with time left and hit share (red with what to rewrite when expired), the session cost, folder and branch, changed lines, and `⚡fast` while fast mode is on.
- 5h and 7d rows, drawn as hud drew them and lined up column for column: a 10-cell bar with a `│` clock mark (`━` used, `╌` slack, `─` rest), the percentage, the `▲`/`▼` pace mark in points (amber `▲` ahead of the clock, red past 15 points or from 90% used, green `▼` behind) and the time left, then a projection: `at this pace: 100% in 1h40` when the window would run out before its reset, `at this pace: ~68% at reset` otherwise, and `at recent pace: 100% in 24m ↯` when the last 30 minutes climb at more than 1.5 times the window's average rate (the projection then uses that recent rate). Narrow terminals give up the projection first, then the bars, then the time left.
- Last row: the last turn's duration, agents spawned, edits, errors and its cost (`last turn 2m37s · 2 agents · 4 edits · 0 errors · +$0.18`). The `+$` is the change in the session cost during the turn, so it includes what background agents spent in that time, and the agents counted are those the main loop spawned, Workflow ones included; while subagents run it shows them instead, a pulse (green, red on failure), the role and a clock each, with "+N" for the rest.

Options (`/plugin`): **Above-prompt strip** (`abovePrompt`, on by default; turn it off to hide the strip) and **Pace start** (`paceStart`, points of lead over the clock that still count as on pace, 0 by default). The suggested next prompts hud offered have no replacement. See [Privacy and permissions](../../docs/PRIVACY.md) for what the strip reads.

flightdeck users: `/plugin uninstall flightdeck`. If hud is still installed, both strips show above the prompt; remove it with `/plugin uninstall hud`.

## Edit gate

The plugin option `gate` is off by default. When enabled, it checks the main session's `Edit`, `Write` and `NotebookEdit` calls; subagents always pass through. Local size and path rules decide, with no network request and no API key.

The rules allow a single-file change of at most 5 changed lines and a documentation change (`.md`, `.mdx`, `.txt`, `.rst`) of at most 20. They deny a change to more than 3 files or of more than 100 lines, with a message pointing to developer for code (and to ux for visual work). For a `Write`, whose removed lines are unknown, the added lines count as a lower bound. Workflow, migration, manifest and lockfile paths, unknown line counts and everything else in between ask: in interactive sessions with a surface the call is held for **Proceed** or **Cancel**, and without one it is denied immediately with “Pantheon edit gate requires an interactive session to confirm this edit. Edit denied.” Disabled roles are replaced with a request for the person to handle the work.

An unexpected exception during evaluation holds the edit in an interactive session with the fixed message “Ask the person before proceeding by rules. Please ask the person to handle implementation; the main session should not edit it itself.” Without an interactive surface, recovery denies immediately. If the hold itself fails or is interrupted, the edit is denied rather than run without a decision. Once the call is forwarded, a rejection propagates to the engine without opening another confirmation or executing the tool again.

Exempt paths are `<repo>/.pantheon/plans/**`, `~/.claude/plans/**`, `~/.claude/projects/*/memory/**` and the session scratchpad (`<tmp>/claude-<uid>/*/*/scratchpad/**`, for the current user). `<repo>/.pantheon/flow/**` holds the flows and the state the Stop trusts: it is not exempt, and an edit to it always asks.

The gate judges one tool call at a time: a large refactor made of many small edits can pass call by call. A per-turn accumulator is deliberately out of scope for this version. Bash writes are not gated.

## Flow

The flow is a port of [JevFlow](https://github.com/Parth1811/JevFlow) (v0.2.0) whose claims use Pantheon's roles. A multi-step task is tracked against a flow of phases in `.pantheon/flow/flows/<id>/flow.json`, and the Stop hook decides whether the lead may stop. It is always on and always enforces; to turn it off, disable the plugin.

- **Starting.** At session start, and on a prompt that reads like a multi-step task, the lead is told it may start a flow. It calls the tool `mcp__pantheon__flow` with `action: "start"`, a short `name` and the request as `goal`. That writes a draft bound to the session and returns the planning instructions. The lead writes the phases to the flow.json it names and checks them with `action: "validate"`. Until the flow is laid out the Stop is held, at most 3 times; after that the draft is archived as abandoned.
- **Phases.** Each phase has an `id`, a `name`, a `done_when` sentence and, wherever one exists, a shell `check` that exits 0 only when the phase is done (run from the repository root, under the rules in Checks below). Optional fields:
  - `depends_on`: omitted means the previous phase, and `[]` makes a root. Phases with no dependency between them can run in parallel.
  - `loop`: `{ max_iterations, until }`.
  - `on_fail`: a phase to route to. A phase that is only an `on_fail` target is a side branch, not required for the goal.
  - `side_effect`: done at most once, and never routed back into.
  - `limits` default to 6 blocks per session, 5 restarts, 90 minutes, 200 Jev calls and 120 s per check.
- **Claims.** Each agent claims the phase it takes with `action: "claim"`, `phase` and `as`, its Pantheon role (lead, code-reader, docs-reader, developer, ux, architect or qa). An Agent spawned as `pantheon:<role>` whose description starts with `[<phase id>]` (for example `[docs] Update the README`) claims that phase for its role automatically. Claims are advisory: the status and the Flow tab show them, and the Stop policy never reads them. The lead's claim ends with its turn. A session can join a flow another session runs in the same folder with `action: "join"`.
- **Stop.** At the lead's Stop:
  1. The checks of the current phase and of every done phase run, each one only when it is allowed (see Checks).
  2. Budgets, caps, regressions and loop phases decide without Jev.
  3. Otherwise Jev (`typesafe/jev-1.13` over OpenRouter) is asked which phase the work is on, whether it is done, stuck, off the goal or claiming done, and then to verify the winning phase.
  4. A fixed policy table decides. A phase advances only when Jev's phase and verification are confident and its check passes, and a check always outranks Jev. A premature "done", a failing check, a loop or a regression holds the stop with the reason and the failing output.
  5. A decision a human must make is written to `NEEDS_HUMAN.md` in the flow's folder.

  A finished flow moves to `.pantheon/flow/done/<id>/` with a `SUMMARY.md`. Your next prompt refills the block budget.
- **Checks.** A check is a shell command (`/bin/sh -c`, from the repository root) that the flow runs outside Claude Code's permission system, so it runs only when one of two things allows it. Claude Code's permission rules allow it as a `Bash` command: an allow rule such as `Bash(npm test:*)` lets the check run without asking. Or you approve that exact command in the Pantheon box, titled "Pantheon flow check", with Proceed; the approval is kept for that repository in the plugin's store, so the same command is not asked again. A command that the rules deny, or that needs permission in a session with no one to answer, does not run: its check counts as failed and the Stop holds with `not run: <reason>`. The time budget for a Stop's checks starts after those decisions, so waiting for you does not use it. In auto mode every check command asks once, since the classifier does not judge plugin commands.
- **Jev.** The plugin option `judgeKey` is your OpenRouter key. Without it, every Stop decides on the checks alone. With it, the request sends the flow's goal and phases, the check results with a tail of failing output, the tail of the lead's last message, the uncommitted file names with line counts (diffs only with `privacy.send_diff`) and the last decisions. Secrets in common shapes are removed first. The key is sent only in the Authorization header.
- **Status.** `/pantheon flow`, `action: "status"` and the panel's Flow tab show the phases with their status, checks and claims, the budgets, the recent decisions and any pending human question. With no `judgeKey`, the status, the Flow tab and a once-per-session toast say that Jev is off.
- **Fail open.** Any internal error allows the stop.

## Configuration

Layers apply in order: built-in defaults, `~/.claude/pantheon.json`, then `<repo>/.claude/pantheon.json`, merged field by field. Each file holds only what changes. For example:

```json
{
  "agents": {
    "developer": { "model": "opus", "effort": "high", "prompt": "..." },
    "code-reader": { "model": "sonnet" }
  },
  "council": { "seats": { "beta": { "model": "fable" } } },
  "disabledAgents": ["ux"]
}
```

- `agents.<role>` and `council.seats.<seat>` accept `model`, `effort` and `prompt` (appended to the role's prompt). The council has two seats, `alpha` and `beta`; a config cannot add a third. Any other seat name under `council.seats` fails with `council.seats.<name>: unknown seat; the council has two seats (alpha, beta)`.
- Models must be Claude models: the aliases `opus`, `sonnet`, `haiku`, `fable`, `opusplan`, `default` and `inherit` (optionally with a bracket suffix such as `[1m]`), or an ID containing `claude`. Effort is not validated.
- `disabledAgents` takes role names, `councillor:alpha`, `councillor:beta` and `"council"`, combined as a union across layers. A `councillor:<seat>` naming any other seat fails with `disabledAgents: councillor:<seat> is not a seat; the council has two seats (alpha, beta)`.
- An invalid config shows a toast and the native agents stay as in the last valid config (or the defaults). The config is read again on every turn; no reload needed.

`/pantheon config` shows the effective configuration and field origins.

### Migrating to 0.18

`git` is no longer a role: the lead squashes, pushes and opens PRs/MRs itself, and `developer` and `ux` commit their own task. The hold on `git`, `gh` and `glab` shell commands is gone too. A config with `disabledAgents: ['git']` or an `agents.git` entry now fails to load with a message that the role was removed in 0.18; delete them.

### Migrating to 0.17

Pantheon now runs only native Claude subagents: Codex, the `delegate`, `delegate_result` and `delegate_cancel` tools, `/pantheon cancel` and profiles are gone. A config that still uses them fails to load with a message saying what to do:

- `profile` and `profiles`: move each role's `model` and `effort` from `profiles.<name>.agents.<role>` to `agents.<role>` (and seats to `council.seats.<seat>`), then delete both fields. Clear the old **Active profile** value in `/config` if you set one.
- `sandboxCap`, `noNetwork`, `foregroundMinutes`, and `engine` or `sandbox` in a role or seat: delete them.
- Role renames: `explorer` is now `code-reader`, `librarian` is `docs-reader`, `executor` is `developer`, `designer` is `ux` and `oracle` is `architect`; the council seats keep their names, and the main session is labeled `lead` in the panel. Rename the keys under `agents` and the entries in `disabledAgents`; the native agents are now `pantheon:<new name>`. A config that still uses old names fails to load with one message listing every old name found in the file (in `agents` and in `disabledAgents`) with its new name (for example ``role `executor` was renamed to `developer`; use `agents.developer` ``), and there is no alias. Until the file is fixed Pantheon keeps the last valid configuration, which is the defaults at startup: disabled roles come back and your overrides are ignored, and it shows a toast with the error.
- Routing: `developer` writes all code, UI code and logic included; `ux` owns look and feel and implements it, and keeps the design criteria of the old designer. The split is by kind of work, not by file extension. `developer` and `ux` commit their own task; the lead pushes.

### Migrating to 0.15

The `fixer` role became `executor` in 0.15 and is `developer` since 0.17. Rename `agents.fixer` to `agents.developer` and replace `fixer` with `developer` in `disabledAgents`. Configs that still use `fixer` fail to load with a message naming `developer`; there is no alias.

## Council

Ask for a council ("run a council", "second opinion", "quero consenso", "segunda opinião", "conselho") and the lead gets Council Mode: it dispatches every active seat in the background in the same turn, collects each answer as it arrives and synthesizes under `## Council Response`, `## Per-Councillor Details` and `## Council Summary`. Only prompts you type (terminal or Remote Control) trigger it, never quoted code, slash commands or SDK prompts.

## Skills

Three skills carry the workflow, and the lead invokes them itself when their description applies.

| Skill | Use |
| --- | --- |
| `flow` | Working inside a flow: starting one, laying out the phases, claiming a phase as a role, and what to do when a `[Pantheon flow]` instruction holds the stop. |
| `debug` | On a bug or failing test: reproduce, form hypotheses, confirm the cause, then fix. |
| `finish` | Before claiming work is done: the flow complete, the real validation, one architect review of the branch, then the lead pushes and opens the PR/MR. |

## Security

Agents follow the session's permission mode and inherit its tools, MCP servers included, and that includes MCP tools that write. The architect, qa and council seats have Edit, Write and NotebookEdit withheld (qa writes only in the scratchpad, through Bash). The read-only roles (code-reader, docs-reader, architect, qa and council seats) also have the Agent tool withheld. Code-reader and docs-reader keep Edit and Write, and their prompts tell them not to change files, git or external state through Bash. The docs-reader may read a logged-in page through a `terminal-browser` the lead names, read only: no login, credentials, form submissions or clicks that change data, and it releases the browser when done. Developer and ux may write within their assigned scope. They keep the Agent tool; their prompts forbid sub-delegation, without separate enforcement.

## Develop

```
claude plugin validate plugins/pantheon
claude plugin test plugins/pantheon
claude --plugin-dir plugins/pantheon
```

`hooks/register.tsx` holds every hook and every `$` call. `tracking.ts` contains pure reducers for native subagents and the main session, plus tool-input redaction; `roster.ts` joins them with Codex jobs in the fixed role slots. `pane.tsx` draws the agents view and its layouts, `jevflow/view.tsx` the Flow tab, with `rail.tsx` (the animated rail) and `elapsed.tsx` (live clocks) as surface modules and `theme.ts` holding the shared palette and cell helpers. Other host access is injected. The panel uses `pantheon.natives`, `pantheon.session` and `pantheon.view` in `$.state`. The original design and implementation history are in git.

## Credits

The orchestrator, role and council prompts are adapted from [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) (MIT, see `LICENSE` and `NOTICE`).

The panel's rail, clock, native tracking and tool description/redaction code is adapted from Stephen Casella's work under the MIT License; see `NOTICE` for its provenance, adaptations and full license text.

The above-prompt strip (`hooks/strip/`, except `agents.ts`, `box.ts`, `pace.ts`, `receipt.ts` and `runs.ts`) is adapted from Apache-2.0 work (Token Weather by Anthropic PBC, token-weather-usage by Eric Cologni); those files stay under the Apache License 2.0 (see `LICENSE-APACHE` and `NOTICE`). The rest of pantheon is MIT.
