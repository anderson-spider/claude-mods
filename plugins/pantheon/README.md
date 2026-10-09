# Pantheon

A Claude Code mod in the style of [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim): the main Claude session is the orchestrator and delegates to specialists. Named profiles choose the engine and model for each role and council seat. The default profile, `claude`, runs all specialists as native Claude agents; `codex` runs them through `codex exec`, and `mixed` keeps the engines used in 0.3.

## Install

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install pantheon@spider-claude-mods
```

The [Codex CLI](https://github.com/openai/codex) must be on `PATH` and logged in (`codex login`) only for roles or seats on Codex. `/pantheon doctor` checks both; when the profile has no Codex roles or seats, missing CLI or login is informational. It also pings every role and council seat: Codex ones with a real `codex exec` (60 s limit, not listed as jobs), and Claude ones by asking the session, after the report, to call each `pantheon:*` agent, so they show as `pending` in the report. Disabled roles and seats show as `off`.

## Roles

| Role or seat | `claude` (default) | `codex` | `mixed` |
| --- | --- | --- | --- |
| explorer | claude `haiku` | codex `gpt-6-luna`, high | codex `gpt-6-luna`, high |
| librarian | claude `haiku` | codex `gpt-6-luna`, high | codex `gpt-6-luna`, high |
| executor | claude `sonnet` | codex `gpt-6.1-sol`, high | codex `gpt-6.1-sol`, high |
| oracle | claude `opus` | codex `gpt-6-astra`, high | claude `opus` |
| designer | claude `sonnet` | codex `gpt-6.1-sol`, high | claude `sonnet` |
| git | claude `haiku` | codex `gpt-6-luna`, low | codex `gpt-6-luna`, low |
| seat alpha | claude `opus` | codex `gpt-6-astra`, high | codex `gpt-6-astra`, high |
| seat beta | claude `sonnet` | codex `gpt-6.1-sol`, high | claude `opus` |

All six roles and every seat can use either engine. The orchestrator calls a Codex role with `delegate({ agent: "<role>", prompt })` and a Claude role with `Agent({ subagent_type: "pantheon:<role>", prompt })`. Seats use `councillor:<seat>` on Codex or `pantheon:councillor-<seat>` on Claude.

The orchestrator gets a system prompt section, adapted from the slim `orchestrator.ts`, that says when to delegate, how to parallelize and how to call each role. A disabled role leaves that section and the Agent tool.

The `executor` role implements code changes and runs scripts, test batteries and API calls within the orchestrator’s brief, returning short results (status, tables or errors). It does no external research or sub-delegation and leaves commits and history operations to `git`.

The `git` role handles commits, squash, push and PR/MR creation after validation. The orchestrator decides and validates; its brief specifies the included changes, branch, base, squash, push and PR/MR choices, and the task's commit range for history rewrites. Git reads status and diffs, preserves unrelated changes, follows commit conventions and PR/MR templates, uses `gh` or `glab` for the remote, and reports commit SHAs, push results, the PR/MR URL and refusals.

Its fixed refusals cover modifying default or protected branches (including main/master/develop), unverified branch protection, force push without `--force-with-lease`, PR/MR merges, remote branch deletion, history rewrites outside an explicit task commit range, and work outside the task.

### Tools

- `delegate({ agent, prompt, description?, cwd?, model?, effort?, background?, resume? })` runs a role or council seat currently on Codex. It stays in the foreground up to `foregroundMinutes`; past that it returns `{ jobId, status: "background" }` and prompts the session when the job ends. `resume: <jobId>` continues the Codex session of a finished job, in the same `cwd`. A role moved to Claude cannot resume through `delegate`; the tool directs the orchestrator to its native Agent instead. A per-call `model` must be valid for Codex. The `delegate*` tools are deferred (behind ToolSearch, no fixed context) while no role or council seat is on Codex, and listed once one is; a profile change refreshes this on the next turn.
- `delegate_result({ jobId })` gives a job's state and result.
- `delegate_cancel({ jobId })` kills the process and marks the job `cancelled`; partial changes stay on disk.

### Commands

- `/pantheon` opens or focuses the panel, which also opens by itself at session start.
- `/pantheon close` closes the panel.
- `/pantheon cancel <jobId>`, `/pantheon config` (effective config, where each field came from, current error) and `/pantheon doctor`.
- The status line shows `pantheon: N running · M in background` while jobs are active.

## Panel

The panel keeps eight role slots in order: orchestrator, explorer, librarian, executor, oracle, designer, git and council. Running lists one row per live instance (parallel runs each get a row, and each council seat has its own); Idle lists exactly one row per role and council seat with nothing live, showing the latest run's model, duration and task plus a strip of `▰` marks for the role's last four rounds, shown only from two rounds on (green done, red failed, `+N` for older ones). Disabled roles and seats show as `⊘` rows, and a lost run counts as Idle. Groups fold to their headings when the pane is short. Other native subagents appear under "other agents" when present. Running rows show model, elapsed time, context use and last activity; roles that never ran leave the time and task blank and keep their role color; when a role last ran shows in the timeline and the mini view. A "Session log" card at the bottom lists the last eight events (round started, done, failed, lost or stopped, disabled roles) with the time and the role in its color; end lines name the task, so parallel runs of one role stay apart; it is the first card to drop when the pane is short. The orchestrator shows its model, effort, turn clock, context and the roles it is delegating to.

The desktop panel follows the former hud plugin's dark palette, tinted segments and 6px corners. The header, session card, agent groups and timeline share a 24px inset; the timeline follows the available pane width. Cost, Tokens and Time are horizontal segments below the session card, with fixed numeric slots (9, 7 and 6 cells); they wrap on narrow panes and become plain label/value rows when an individual segment cannot fit, stacking the value below the label at the smallest widths. Cost comes from the host's ledger and reads `—` until a measurement arrives. Tokens adds each agent's context or input and output, so it is a rough size, not a bill. Collapsible Running and Idle groups use full-width hairline separators. Each desktop row leads with role and model, followed by the task and readings; its state marker has a fixed slot. Planned text uses the readable secondary color. Native text and buttons sit over static SVG backgrounds, so they remain selectable and actionable.

The terminal panel draws one bordered card per section, each with its own border color, task-first rows, context progress bars and one-line Cost, Tokens and Time readings. Its close button appears from 58 columns. A rail animates at 110 ms only while an agent has active work, and clocks tick live.


A running Codex row shows its job id (dim, the first thing to drop on narrow panes) and a Cancel button that stops its job; Claude agents and Idle rows have none, and `/pantheon cancel <jobId>` and the `delegate_cancel` tool stay available. The footer reads `keys: esc close`. The header shows `working` while only the main session runs, and the running-agent count when roles are active.

The terminal panel docks beside the transcript and uses a mini view when placed inline. Desktop adds a "Last 15 minutes" SVG timeline with a lane per role. The orchestrator lane draws completed turns in gray and the current running turn in white; completed turns are retained for 15 minutes, up to 50 entries. The docked and mini layouts have clocks and steady text dots on running rows; desktop has clocks and steady SVG image dots. The timeline is computed once per draw and advances in 15-second steps. A run shorter than one step still draws one step wide. Engine color appears in terminal row stripes and desktop instance ids and timeline bars; inactive timers pause. The panel has no configuration.

The tracking hooks only watch and pass events on unchanged. Native records, main-session readings and the folded groups are saved in session state through queues that keep only the latest pending snapshot. The panel shows one toast per session the first time saving the panel state (agents, session or folded groups) fails; jobs keep their own warning. See [Privacy and permissions](../../docs/PRIVACY.md#pantheon) for the stored fields and tool-input redaction.

## Above-prompt strip

Since 0.13.0 pantheon draws an always-on strip above the prompt, absorbed from the former hud plugin:

A rounded box in flightdeck's mini style, at most four rows, kept next to the prompt:

- Session row: model and effort, working or idle, the context as a gauge with its percentage, the prompt cache with time left and hit share (red with what to rewrite when expired), the session cost, folder and branch, changed lines, and `⚡fast` while fast mode is on.
- 5h and 7d rows, drawn as hud drew them and lined up column for column: a 10-cell bar with a `│` clock mark (`━` used, `╌` slack, `─` rest), the percentage, the `▲`/`▼` pace mark in points (amber `▲` ahead of the clock, red past 15 points or from 90% used, green `▼` behind) and the time left, then a projection: `at this pace: 100% in 1h40` when the window would run out before its reset, `at this pace: ~68% at reset` otherwise, and `at recent pace: 100% in 24m ↯` when the last 30 minutes climb at more than 1.5 times the window's average rate (the projection then uses that recent rate). Narrow terminals give up the projection first, then the bars, then the time left.
- Last row: the last turn's duration, agents spawned, edits, errors and its cost (`last turn 2m37s · 2 agents · 4 edits · 0 errors · +$0.18`). The `+$` is the change in the session cost during the turn, so it includes what background agents spent in that time, and the agents counted are those the main loop spawned, Workflow ones included; while Pantheon jobs or native subagents run it shows them instead, a pulse (green, red on failure), the role and a clock each, with "+N" for the rest.

Options (`/plugin`): **Above-prompt strip** (`abovePrompt`, on by default; turn it off to hide the strip) and **Pace start** (`paceStart`, points of lead over the clock that still count as on pace, 0 by default). The suggested next prompts hud offered have no replacement. See [Privacy and permissions](../../docs/PRIVACY.md) for what the strip reads.

flightdeck users: `/plugin uninstall flightdeck`. If hud is still installed, both strips show above the prompt; remove it with `/plugin uninstall hud`.

## Edit gate

The plugin option `gate` is off by default. When enabled, it checks the main session's `Edit`, `Write` and `NotebookEdit` calls; subagents always pass through. Set the sensitive option `jevApiKey` to an OpenRouter API key, or leave it unset to use `OPENROUTER_API_KEY`.

The decision model through OpenRouter scores whether the edit is trivial: a score at or above `0.85` passes, at or below `0.30` denies with a message pointing to the executor (and the designer for UI files), and the grey zone holds the call for **Proceed** or **Cancel**. Disabled roles are replaced with a request for the person to handle the work. The thresholds are constants, not options.

Only edit metadata leaves the machine: the tool name; a closed `kind` (`docs`, `test`, `source`, `ui`, `config`, `workflow`, `migration`, `manifest`, `lockfile`, `other`); an extension from the closed set `md`, `mdx`, `txt`, `rst`, `ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `json`, `yaml`, `yml`, `toml`, `css`, `scss`, `html`, `svelte`, `vue`, `py`, `go`, `rs`, `java`, `kt`, `swift`, `sh`, `sql`, `lock` (anything else becomes `other`); lines added and removed when known; the file count; and the fixed caller label `main orchestrator session`. Paths, contents, `old_string`, `new_string` and notebook source are never sent. With the gate off, no decision request is made.

A missing key, request error, 3 s timeout or malformed answer falls back to local size and path rules. Those rules allow tiny edits, ask when uncertain or on sensitive paths, and deny large changes; a decision-service failure alone never causes a denial. An unexpected exception before a decision holds the edit with the fixed message “Ask the person before proceeding by rules. Please ask the person to handle implementation; the main session should not edit it itself.” If the hold itself fails or is interrupted, the edit is denied rather than run without a decision.

Exempt paths are `<repo>/.pantheon/**`, `~/.claude/plans/**`, `~/.claude/projects/*/memory/**` and the session scratchpad (`<tmp>/claude-<uid>/*/*/scratchpad/**`, for the current user). Paths are resolved through filesystem links before exemptions are checked. Everything else under `~/.claude` is gated.

The gate judges one tool call at a time: a large refactor made of many small edits can pass call by call. A per-turn accumulator is deliberately out of scope for this version. Bash writes are not gated.

## Configuration

Layers apply in order: built-in defaults, `~/.claude/pantheon.json`, then `<repo>/.claude/pantheon.json`; the `profile` field in `/config` is applied last for the profile choice only. Each file holds only what changes. Top-level `profile` selects the active profile (default `claude`); the project selection overrides the user selection, and the `/config` choice overrides both when set. For example:

```json
{
  "profile": "mixed",
  "profiles": {
    "mixed": { "agents": { "executor": { "model": "gpt-6-astra" } } },
    "mine": {
      "agents": { "oracle": { "engine": "codex", "model": "gpt-6-astra" } },
      "council": { "seats": { "beta": { "engine": "codex" } } }
    }
  },
  "agents": { "executor": { "prompt": "...", "sandbox": "read-only" } }
}
```

- `profiles.<name>.agents.<role>` and `profiles.<name>.council.seats.<seat>` accept only `engine`, `model` and `effort`, merged field by field. A custom profile inherits the fully merged `claude` profile. Changing an entry's engine drops its inherited model and effort unless that same layer supplies them.
- Top-level `agents.<role>` accepts only `prompt` (appended to the role's prompt) and `sandbox`; top-level `council.seats.<seat>` accepts only `prompt`. These settings apply to every profile. Every seat needs an engine in its profile; a prompt-only seat missing from the active profile is rejected.
- `sandboxCap` defaults to `workspace-write`, `noNetwork` to `false`, `foregroundMinutes` to `5` and `disabledAgents` to `[]`. `disabledAgents` takes role names, `councillor:<seat>` and `"council"`, combined as a union across layers.
- `sandboxCap` and `noNetwork` merge to the most restrictive of default, user and project: a project never loosens the user's config. Codex sandboxes can only narrow from the role default: explorer, librarian, oracle and council seats are read-only; executor, designer and git default to workspace-write. `danger-full-access` is refused.
- Validation runs after merging, over every profile, including inactive profiles. An unknown active profile, missing seat engine or incompatible engine/model pair rejects the config. Claude accepts aliases `opus`, `sonnet`, `haiku`, `fable`, `opusplan`, `default` and `inherit` (optionally with a bracket suffix such as `[1m]`), or an ID containing `claude`. Codex accepts other model strings and rejects those Claude names. Omitting `model` is valid for either engine. Effort is not validated; supported values differ by engine.
- An invalid config shows a toast, `delegate` refuses every call until it is fixed, and the native agents stay as in the last valid config (or the defaults).
- The config is read again on every `delegate` and every turn; no reload needed.

`/pantheon config` shows the active profile, effective configuration and field origins. Profile switches update the offered native agents and delegation routes.

Pick the profile in `/config` (field `pantheon.profile`, free text) or with the selector in the panel header. Both write the same field, and the `/config` field accepts only names of built-in profiles or profiles defined in the JSON files; an unknown name, or any change while the JSON config is invalid, is refused with the reason. When a JSON file sets `profile` and `/config` has no choice, the panel selector is locked and names that file; once a profile is chosen in `/config` or the panel, it wins. A profile saved in `/config` overrides the JSON `profile`, so if you chose one before this version, clear the field (an empty value is accepted) to let the JSON files decide again.

### Migrating to 0.15

The role is now `executor`, including the native agent `pantheon:executor`. Rename `agents.fixer` to `agents.executor` at the top level and under every `profiles.<name>`, and replace `fixer` with `executor` in `disabledAgents`. Configs that still use `fixer` in those fields fail to load with a message naming `executor`; there is no alias.

### Migrating from 0.3

Version 0.4.0 changes the default to `claude`. Set `"profile": "mixed"` to keep the old engines. The old engine/model/effort fields under top-level roles and seats are removed; move per-role and per-seat values into `profiles.<name>`. Those fields produce a migration error naming the new path. A top-level `model` was already rejected in 0.3 and is still reported as an unknown field. Keep prompts and sandbox settings outside profiles.

The equivalent of the old engine split with a customized executor model is:

```json
{"profile":"mixed","profiles":{"mixed":{"agents":{"executor":{"model":"…"}}}}}
```

Replace `…` with your Codex model. The sandbox change also applies to `mixed`: setting explorer or librarian to `workspace-write` no longer widens their read-only default.

## Council

Ask for a council ("run a council", "second opinion", "quero consenso", "segunda opinião", "conselho") and the orchestrator gets Council Mode: it dispatches every active seat in the background in the same turn, collects each answer as it arrives and synthesizes under `## Council Response`, `## Per-Councillor Details` and `## Council Summary`. Only prompts you type (terminal or Remote Control) trigger it, never quoted code, slash commands or SDK prompts.

## Skills

Four skills carry the workflow, and the orchestrator invokes them itself when their description applies. They replace the superpowers integration, so the superpowers plugin is not needed.

| Skill | Use |
| --- | --- |
| `grill` | Before creative or multi-step work: interviews you one question at a time, reads code and docs through the explorer and librarian, opens a worktree with `EnterWorktree` and writes the plan. |
| `execute` | Carries out the plan: briefs the executor or designer from the task section, requires the test first, delegates commits to git, and sends only `risk: yes` tasks to the oracle. |
| `debug` | On a bug or failing test: reproduce, form hypotheses, confirm the cause, then fix. |
| `finish` | Before claiming work is done: runs the real validation, one oracle review of the branch, then delegates push and PR/MR creation to git. |

- The plan lives in `.pantheon/plans/YYYY-MM-DD-<topic>.md`. `grill` adds `.pantheon/` to the repository's `info/exclude`, so it is never committed and goes away with the worktree.
- Each task lists goal, files, interfaces, acceptance, `risk` and `parallel`. Tasks run in sequence unless marked `parallel: yes` with disjoint files; explorer and librarian lanes always run in parallel.
- A failed task is retried once by the same implementer, then diagnosed by the oracle, then handed to you. An oracle gate is one review plus at most two re-reviews.
- The worktree starts from `origin/<default branch>` unless `worktree.baseRef` is `head`.

## Security

- **Workspace**: a `delegate` `cwd` must resolve, symlinks followed, inside the session's repository root (or the session directory outside a repository). `resume` always reuses the job's stored `cwd` and checks it again.
- **Sandbox**: for Codex, the effective sandbox is the most restrictive of the role default, `agents.<role>.sandbox` and `sandboxCap`; council seats are always read-only. Explorer, librarian and oracle default to read-only; executor, designer and git default to workspace-write. Runs other than git pass `-c sandbox_workspace_write.writable_roots=[]`, so extra writable roots in your `config.toml` do not widen writes. `/tmp` and `$TMPDIR` stay writable.
- **Git sandbox exception**: only the Codex git role gets workspace-write with the repository's git common dir as an extra writable root and network explicitly on. The common dir is resolved with `git rev-parse --path-format=absolute --git-common-dir` and `realPath` from both the session repository root and the requested `cwd`, with Git location environment overrides removed for both probes; the resolved directories must match. It refuses before spawning if resolution fails, `sandboxCap` is `read-only`, `noNetwork` is `true`, or `agents.git.sandbox` is `read-only`. The doctor ping stays read-only, without the extra writable root or explicit network grant.
- **Git trust**: write access to the whole git dir lets the role change `.git/hooks` and Git config such as `core.hooksPath` and `core.sshCommand`, which can run code later in your own shell. If that trust is not acceptable, disable `git` through `disabledAgents`, or keep `noNetwork: true` or `sandboxCap: "read-only"` to block the Codex git role.
- **`--ignore-rules`**: every run ignores Codex `.rules` files, because an `allow` rule would run commands outside the sandbox. The cost: your `forbidden` rules do not apply inside Pantheon either; the sandbox still does.
- **Native agents** follow the session's permission mode; `sandbox`, `sandboxCap` and `noNetwork` do not apply to them. Every native role inherits the session's tools, MCP servers included. That includes MCP tools that write. Oracle and council seats have Edit, Write and NotebookEdit withheld. The read-only roles (explorer, librarian, oracle and council seats) also have Agent and the delegate tools withheld. Explorer and librarian keep Edit and Write, and their prompts tell them not to change files, git or external state through Bash. The librarian may read a logged-in page through a `terminal-browser` the orchestrator names, read only: no login, credentials, form submissions or clicks that change data, and it releases the browser when done. Executor, designer and git may write within their assigned scope. Native git has `disallowedTools` Agent, `mcp__pantheon__delegate` and `mcp__pantheon__delegate_cancel`. Executor and designer keep the delegation tools; their prompts forbid sub-delegation, without separate enforcement.

## Develop

```
claude plugin validate plugins/pantheon
claude plugin test plugins/pantheon
claude --plugin-dir plugins/pantheon
```

`hooks/register.tsx` holds every hook and every `$` call. `tracking.ts` contains pure reducers for native subagents and the main session, plus tool-input redaction; `roster.ts` joins them with Codex jobs in the fixed role slots. `pane.tsx` draws the agents view and its layouts, with `rail.tsx` (the animated rail) and `elapsed.tsx` (live clocks) as surface modules and `theme.ts` holding the shared palette and cell helpers. Other host access is injected. The panel uses `pantheon.natives`, `pantheon.session` and `pantheon.view` alongside `pantheon.jobs` in `$.state`. `docs/design.md` and `docs/plan.md` preserve the original design and implementation history.

## Credits

The orchestrator, role and council prompts are adapted from [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) (MIT, see `LICENSE` and `NOTICE`).

The panel's rail, clock, native tracking and tool description/redaction code is adapted from Stephen Casella's work under the MIT License; see `NOTICE` for its provenance, adaptations and full license text.

The above-prompt strip (`hooks/strip/`, except `agents.ts`, `box.ts`, `pace.ts`, `receipt.ts` and `runs.ts`) is adapted from Apache-2.0 work (Token Weather by Anthropic PBC, token-weather-usage by Eric Cologni); those files stay under the Apache License 2.0 (see `LICENSE-APACHE` and `NOTICE`). The rest of pantheon is MIT.
