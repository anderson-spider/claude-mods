# Pantheon

A Claude Code mod in the style of [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim): the main Claude session is the orchestrator and delegates to specialists. Named profiles choose the engine and model for each role and council seat. The default profile, `claude`, runs all specialists as native Claude agents; `codex` runs them through `codex exec`, and `mixed` keeps the engines used in 0.3.

## Install

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install pantheon@spider-claude-mods
```

The [Codex CLI](https://github.com/openai/codex) must be on `PATH` and logged in (`codex login`) only for roles or seats on Codex. `/pantheon doctor` checks both; when the profile has no Codex roles or seats, missing CLI or login is informational.

## Roles

| Role or seat | `claude` (default) | `codex` | `mixed` |
| --- | --- | --- | --- |
| explorer | claude `haiku` | codex `gpt-6-luna`, high | codex `gpt-6-luna`, high |
| librarian | claude `haiku` | codex `gpt-6-luna`, high | codex `gpt-6-luna`, high |
| fixer | claude `sonnet` | codex `gpt-6.1-sol`, high | codex `gpt-6.1-sol`, high |
| oracle | claude `opus` | codex `gpt-6-astra`, high | claude `opus` |
| designer | claude `sonnet` | codex `gpt-6.1-sol`, high | claude `sonnet` |
| seat alpha | claude `opus` | codex `gpt-6-astra`, high | codex `gpt-6-astra`, high |
| seat beta | claude `sonnet` | codex `gpt-6.1-sol`, high | claude `opus` |

All five roles and every seat can use either engine. The orchestrator calls a Codex role with `delegate({ agent: "<role>", prompt })` and a Claude role with `Agent({ subagent_type: "pantheon:<role>", prompt })`. Seats use `councillor:<seat>` on Codex or `pantheon:councillor-<seat>` on Claude.

The orchestrator gets a system prompt section, adapted from the slim `orchestrator.ts`, that says when to delegate, how to parallelize and how to call each role. A disabled role leaves that section and the Agent tool.

### Tools

- `delegate({ agent, prompt, description?, cwd?, model?, effort?, background?, resume? })` runs a role or council seat currently on Codex. It stays in the foreground up to `foregroundMinutes`; past that it returns `{ jobId, status: "background" }` and prompts the session when the job ends. `resume: <jobId>` continues the Codex session of a finished job, in the same `cwd`. A role moved to Claude cannot resume through `delegate`; the tool directs the orchestrator to its native Agent instead. A per-call `model` must be valid for Codex.
- `delegate_result({ jobId })` gives a job's state and result.
- `delegate_cancel({ jobId })` kills the process and marks the job `cancelled`; partial changes stay on disk.

### Commands

- `/pantheon` opens or focuses the panel, which also opens by itself at session start.
- `/pantheon close` closes the panel.
- `/pantheon cancel <jobId>`, `/pantheon config` (effective config, where each field came from, current error) and `/pantheon doctor`.
- The status line shows `pantheon: N running · M in background` while jobs are active.

## Panel

The Agents tab keeps seven role slots in order: orchestrator, explorer, librarian, fixer, oracle, designer and council. Parallel instances stack inside their role; resumed work stays on the same line with its rounds. Every finished instance stays in the Finished group, newest end first within its role; groups fold to their headings when the pane is short. Other native subagents appear under "other agents" when present. Active instances show their model, elapsed time, tokens and last activity; roles that have not run appear as planned rows ("Waiting for work") and disabled roles stay visible as off; when a role last ran shows in the timeline and the mini view. The orchestrator shows its model, effort, turn clock, context and the roles it is delegating to.

The desktop panel follows HUD's dark palette, tinted segments and 6px corners. The header, session card, agent groups and timeline share a 24px inset; the timeline follows the available pane width. Tab buttons always register their shortcuts; the footer repeats them as visual hints. Cost, Tokens and Time are horizontal segments below the session card, with fixed numeric slots (9, 7 and 6 cells); they wrap on narrow panes and become plain label/value rows when an individual segment cannot fit, stacking the value below the label at the smallest widths. Cost comes from the host's ledger and reads `—` until a measurement arrives. Tokens adds each agent's context or input and output, so it is a rough size, not a bill. Collapsible Running, Finished and Planned groups use full-width hairline separators. Each desktop row leads with role and model, followed by the task and readings; its mascot and state marker have fixed slots. Planned text uses the readable secondary color. Native text and buttons sit over static SVG backgrounds, so they remain selectable and actionable.

The terminal panel keeps its existing theme, header, bordered groups, task-first rows, context progress bars and one-line Cost, Tokens and Time readings. Its close button appears from 58 columns. Docked and inline layouts use the same Clawd body, 9 columns by 3 rows, with one additional row for a role-specific hat.

The desktop mascot is a side-on Claude with a hat and a held prop per role: a detective hat and magnifier for the explorer, a mortarboard and book for the librarian, a light laptop and a mug of coffee for the fixer, a wizard hat, wand and stars for the oracle, a beret and brush for the designer, a curled wig and gavel for the council, a captain's hat and a clipboard with a hanging pen for the orchestrator. It walks while the agent works and stands still otherwise. On desktop it is an SVG whose objects also move while working (the oracle's stars twinkle, the laptop screen scrolls, a glint sweeps the lens), and `prefers-reduced-motion` keeps it still. Idle and off SVGs are transparent; working interactive SVGs paint the exact surrounding pane or session-card color to cover the host's white canvas. Mascot keys and viewport sizes stay fixed across ticks; motion stays inside the SVG. In the terminal, an independently drawn quadrant sprite has a terracotta body, dark eyes and a transparent exterior, with a hat above the body: a captain’s cap for the orchestrator, field hat for the explorer, mortarboard for the librarian, hard hat for the fixer, wizard hat for the oracle, beret for the designer and judicial cap for the council. All roles share the same body and poses, in a fixed 9 x 4 frame including the hat; names and panel colors also identify the roles. While working, it cycles every 250 ms through the default pose, looking right, raised arms and looking left. Idle uses the default pose, off dims it, and each new work period restarts the sequence. Without a Client, the panel draws the same colored default pose statically.

The Jobs tab groups active and finished Codex jobs, with Cancel for active jobs and Copy for the job id and a resume hint. Below them, a read-only "Claude agent rounds" group lists the rounds of native Claude agents, so the tab is not empty under the `claude` profile; those have no Cancel or Copy. The terminal tab reads `Jobs · N`, with the count separated from its hotkey badge; desktop places the count in its own three-cell slot and retains the host's hotkey badges on the tabs, independently of the footer. The footer starts with `keys:` to identify `1` (Agents), `2` (Jobs) and, on Agents, `esc` (close). The Agents header shows `working` while only the main session runs, and the running-agent count when roles are active. `↻` marks resumable jobs; the orchestrator resumes them with `delegate({ agent, resume: jobId, prompt })`.

The terminal panel docks beside the transcript and uses a mini view when placed inline. Desktop adds a "Last 15 minutes" SVG timeline with a lane per role. The orchestrator lane draws completed turns in gray and the current running turn in white; completed turns are retained for 15 minutes, up to 50 entries. The docked and mini layouts have clocks and steady text dots on running rows; desktop has clocks and steady SVG image dots. The timeline is computed once per draw and advances in 15-second steps. Engine color appears in terminal row stripes and desktop instance ids and timeline bars; inactive timers pause. The panel has no configuration. Rate limits, repository, branch and cache stay in hud.

The tracking hooks only watch and pass events on unchanged. Native records, main-session readings and the selected tab are saved in session state through queues that keep only the latest pending snapshot. The panel shows one toast per session the first time saving the panel state (agents, session or selected tab) fails; jobs keep their own warning. See [Privacy and permissions](../../docs/PRIVACY.md#pantheon) for the stored fields and tool-input redaction.

flightdeck users: `/plugin uninstall flightdeck`.

## Configuration

Layers apply in order: built-in defaults, the `profile` field in `/config`, `~/.claude/pantheon.json`, then `<repo>/.claude/pantheon.json`. Each file holds only what changes. Top-level `profile` selects the active profile (default `claude`); the project selection overrides the user selection, and both override the `/config` choice. For example:

```json
{
  "profile": "mixed",
  "profiles": {
    "mixed": { "agents": { "fixer": { "model": "gpt-6-astra" } } },
    "mine": {
      "agents": { "oracle": { "engine": "codex", "model": "gpt-6-astra" } },
      "council": { "seats": { "beta": { "engine": "codex" } } }
    }
  },
  "agents": { "fixer": { "prompt": "...", "sandbox": "read-only" } }
}
```

- `profiles.<name>.agents.<role>` and `profiles.<name>.council.seats.<seat>` accept only `engine`, `model` and `effort`, merged field by field. A custom profile inherits the fully merged `claude` profile. Changing an entry's engine drops its inherited model and effort unless that same layer supplies them.
- Top-level `agents.<role>` accepts only `prompt` (appended to the role's prompt) and `sandbox`; top-level `council.seats.<seat>` accepts only `prompt`. These settings apply to every profile. Every seat needs an engine in its profile; a prompt-only seat missing from the active profile is rejected.
- `sandboxCap` defaults to `workspace-write`, `noNetwork` to `false`, `foregroundMinutes` to `5` and `disabledAgents` to `[]`. `disabledAgents` takes role names, `councillor:<seat>` and `"council"`, combined as a union across layers.
- `sandboxCap` and `noNetwork` merge to the most restrictive of default, user and project: a project never loosens the user's config. Codex sandboxes can only narrow from the role default: explorer, librarian, oracle and council seats are read-only; fixer and designer default to workspace-write. `danger-full-access` is refused.
- Validation runs after merging, over every profile, including inactive profiles. An unknown active profile, missing seat engine or incompatible engine/model pair rejects the config. Claude accepts aliases `opus`, `sonnet`, `haiku`, `fable`, `opusplan`, `default` and `inherit` (optionally with a bracket suffix such as `[1m]`), or an ID containing `claude`. Codex accepts other model strings and rejects those Claude names. Omitting `model` is valid for either engine. Effort is not validated; supported values differ by engine.
- An invalid config shows a toast, `delegate` refuses every call until it is fixed, and the native agents stay as in the last valid config (or the defaults).
- The config is read again on every `delegate` and every turn; no reload needed.

`/pantheon config` shows the active profile, effective configuration and field origins. Profile switches update the offered native agents and delegation routes.

Pick the profile in `/config` (field `pantheon.profile`, free text) or with the selector in the panel header. Both write the same field, and the `/config` field accepts only names of built-in profiles or profiles defined in the JSON files; an unknown name, or any change while the JSON config is invalid, is refused with the reason. When a JSON file sets `profile`, the panel selector is locked and names the file that wins.

### Migrating from 0.3

Version 0.4.0 changes the default to `claude`. Set `"profile": "mixed"` to keep the old engines. The old engine/model/effort fields under top-level roles and seats are removed; move per-role and per-seat values into `profiles.<name>`. Those fields produce a migration error naming the new path. A top-level `model` was already rejected in 0.3 and is still reported as an unknown field. Keep prompts and sandbox settings outside profiles.

The equivalent of the old engine split with a customized fixer model is:

```json
{"profile":"mixed","profiles":{"mixed":{"agents":{"fixer":{"model":"…"}}}}}
```

Replace `…` with your Codex model. The sandbox change also applies to `mixed`: setting explorer or librarian to `workspace-write` no longer widens their read-only default.

## Council

Ask for a council ("run a council", "second opinion", "quero consenso", "segunda opinião", "conselho") and the orchestrator gets Council Mode: it dispatches every active seat in the background in the same turn, collects each answer as it arrives and synthesizes under `## Council Response`, `## Per-Councillor Details` and `## Council Summary`. Only prompts you type (terminal or Remote Control) trigger it, never quoted code, slash commands or SDK prompts.

## Skills

Four skills carry the workflow, and the orchestrator invokes them itself when their description applies. They replace the superpowers integration, so the superpowers plugin is not needed.

| Skill | Use |
| --- | --- |
| `grill` | Before creative or multi-step work: interviews you one question at a time, reads code and docs through the explorer and librarian, opens a worktree with `EnterWorktree` and writes the plan. |
| `execute` | Carries out the plan: briefs the fixer or designer from the task section, requires the test first, commits, and sends only `risk: yes` tasks to the oracle. |
| `debug` | On a bug or failing test: reproduce, form hypotheses, confirm the cause, then fix. |
| `finish` | Before claiming work is done: runs the real validation, one oracle review of the branch, then the PR. |

- The plan lives in `.pantheon/plans/YYYY-MM-DD-<topic>.md`. `grill` adds `.pantheon/` to the repository's `info/exclude`, so it is never committed and goes away with the worktree.
- Each task lists goal, files, interfaces, acceptance, `risk` and `parallel`. Tasks run in sequence unless marked `parallel: yes` with disjoint files; explorer and librarian lanes always run in parallel.
- A failed task is retried once by the same implementer, then diagnosed by the oracle, then handed to you. An oracle gate is one review plus at most two re-reviews.
- The worktree starts from `origin/<default branch>` unless `worktree.baseRef` is `head`.

## Security

- **Workspace**: a `delegate` `cwd` must resolve, symlinks followed, inside the session's repository root (or the session directory outside a repository). `resume` always reuses the job's stored `cwd` and checks it again.
- **Sandbox**: for Codex, the effective sandbox is the most restrictive of the role default, `agents.<role>.sandbox` and `sandboxCap`; council seats are always read-only. Explorer, librarian and oracle default to read-only; fixer and designer default to workspace-write. Every run passes `-c sandbox_workspace_write.writable_roots=[]`, so extra writable roots in your `config.toml` do not widen writes. `/tmp` and `$TMPDIR` stay writable.
- **`--ignore-rules`**: every run ignores Codex `.rules` files, because an `allow` rule would run commands outside the sandbox. The cost: your `forbidden` rules do not apply inside Pantheon either; the sandbox still does.
- **Native agents** follow their tool list and the session's permission mode; `sandbox`, `sandboxCap` and `noNetwork` do not apply to them. Explorer, oracle and council seats get Read/Grep/Glob; librarian also gets WebSearch/WebFetch. Fixer and designer get all tools, including delegation tools; their prompts forbid sub-delegation, without separate enforcement.

## Develop

```
claude plugin validate plugins/pantheon
claude plugin test plugins/pantheon
claude --plugin-dir plugins/pantheon
```

`hooks/register.tsx` holds every hook and every `$` call. `tracking.ts` contains pure reducers for native subagents and the main session, plus tool-input redaction; `roster.ts` joins them with Codex jobs in the fixed role slots. `pane.tsx` draws the tabs and layouts, with `rail.tsx`, `elapsed.tsx` and `mascot.tsx` as surface modules for animation and clocks, and `clawd.ts` holding the mascot art (pure: quadrant runs for the terminal at one shared 9 x 4 size, an SVG string for desktop). Other host access is injected. The panel uses `pantheon.natives`, `pantheon.session` and `pantheon.view` alongside `pantheon.jobs` in `$.state`. `docs/design.md` and `docs/plan.md` preserve the original design and implementation history.

## Credits

The orchestrator, role and council prompts are adapted from [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) (MIT, see `LICENSE` and `NOTICE`).

The panel's rail, clock, native tracking and tool description/redaction code is adapted from Stephen Casella's work under the MIT License; see `NOTICE` for its provenance, adaptations and full license text.
