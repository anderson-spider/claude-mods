# Pantheon

A Claude Code mod in the style of [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim): the main Claude session is the orchestrator and delegates to specialists. Search, research and implementation roles run on Codex (`codex exec`); architecture, design and part of the council run as native Claude agents.

## Install

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install pantheon@spider-claude-mods
```

Needs the [Codex CLI](https://github.com/openai/codex) on `PATH` and logged in (`codex login`). `/pantheon doctor` checks both.

## Roles

| Role | Runs on | How the orchestrator calls it | Default |
| --- | --- | --- | --- |
| explorer | Codex | `delegate({ agent: "explorer" })` | `gpt-6-luna` high, read-only |
| librarian | Codex | `delegate({ agent: "librarian" })` | `gpt-6-luna` high, read-only |
| fixer | Codex | `delegate({ agent: "fixer" })` | `gpt-6.1-sol` high, workspace-write |
| oracle | Claude | Agent tool, `pantheon:oracle` | `opus`, Read/Grep/Glob |
| designer | Claude | Agent tool, `pantheon:designer` | `sonnet`, every tool |
| council | both | one seat per engine | `alpha` on Codex, `beta` on Claude |

The orchestrator gets a system prompt section, adapted from the slim `orchestrator.ts`, that says when to delegate, how to parallelize and how to call each role. A disabled role leaves that section and the Agent tool.

### Tools

- `delegate({ agent, prompt, description?, cwd?, model?, effort?, background?, resume? })` runs a Codex role. It stays in the foreground up to `foregroundMinutes`; past that it returns `{ jobId, status: "background" }` and prompts the session when the job ends. `resume: <jobId>` continues the Codex session of a finished job, in the same `cwd`.
- `delegate_result({ jobId })` gives a job's state and result.
- `delegate_cancel({ jobId })` kills the process and marks the job `cancelled`; partial changes stay on disk.

### Commands

- `/pantheon` opens or focuses the panel, which also opens by itself at session start.
- `/pantheon close` closes the panel.
- `/pantheon cancel <jobId>`, `/pantheon config` (effective config, where each field came from, current error) and `/pantheon doctor`.
- The status line shows `pantheon: N rodando · M em background` while jobs are active.

## Panel

The Agents tab keeps seven role slots in order: orchestrator, explorer, librarian, fixer, oracle, designer and council. Parallel instances stack inside their role; resumed work stays on the same line with its rounds. Other native subagents appear under "other agents" when present. Active instances show their model, elapsed time, tokens and last activity; idle roles show when they last ran and disabled roles stay visible as off. The orchestrator shows its model, effort, turn clock, context and the roles it is delegating to.

The Jobs tab groups active and finished Codex jobs, with Cancel for active jobs and Copy for the job id and a resume hint. `↻` marks resumable jobs; the orchestrator resumes them with `delegate({ agent, resume: jobId, prompt })`.

The terminal panel docks beside the transcript and uses a mini view when placed inline. Desktop adds a "Last 15 minutes" SVG timeline with a lane per role. Animated rails in each engine's color, a pulsing state glyph and live clocks show active work; inactive timers pause. The panel has no configuration. Rate limits, repository, branch and cache stay in hud.

The tracking hooks only watch and pass events on unchanged. Native records and main-session readings use queues that keep only the latest pending snapshot in session state; the selected tab is saved there too. A failed panel-state write shows one toast. See [Privacy and permissions](../../docs/PRIVACY.md#pantheon) for the stored fields and tool-input redaction.

flightdeck users: `/plugin uninstall flightdeck`.

## Configuration

`~/.claude/pantheon.json`, overridden by `<repo>/.claude/pantheon.json`. A file holds only what changes; these are the defaults:

```json
{
  "sandboxCap": "workspace-write",
  "noNetwork": false,
  "foregroundMinutes": 5,
  "disabledAgents": [],
  "agents": {
    "explorer":  { "model": "gpt-6-luna", "effort": "high", "sandbox": "read-only" },
    "librarian": { "model": "gpt-6-luna", "effort": "high", "sandbox": "read-only" },
    "fixer":     { "model": "gpt-6.1-sol", "effort": "high", "sandbox": "workspace-write" },
    "oracle":    { "model": "opus" },
    "designer":  { "model": "sonnet" }
  },
  "council": {
    "seats": {
      "alpha": { "engine": "codex",  "model": "gpt-6-astra", "effort": "high" },
      "beta":  { "engine": "claude", "model": "opus" }
    }
  }
}
```

- Every role and seat takes `model`, `effort` and `prompt` (appended to the role's prompt). Codex roles take `sandbox`. A seat override may change one field; a new seat needs an `engine`.
- `disabledAgents` takes role names, `councillor:<seat>` and `"council"`.
- `sandboxCap` and `noNetwork` merge to the most restrictive of default, user and project: a project never loosens the user's config. `danger-full-access` is refused.
- An invalid config shows a toast, `delegate` refuses every call until it is fixed, and the native agents stay as in the last valid config (or the defaults).
- The config is read again on every `delegate` and every turn; no reload needed.

## Council

Ask for a council ("run a council", "second opinion", "quero consenso", "segunda opinião", "conselho") and the orchestrator gets Council Mode: it dispatches every active seat in the background in the same turn, collects each answer as it arrives and synthesizes under `## Council Response`, `## Per-Councillor Details` and `## Council Summary`. Only prompts you type (terminal or Remote Control) trigger it, never quoted code, slash commands or SDK prompts.

## Superpowers

When a [superpowers](https://github.com/obra/superpowers) skill dispatches a subagent, the orchestrator uses the Pantheon role and keeps the skill's process:

| Skill dispatch | Pantheon |
| --- | --- |
| implementer (subagent-driven-development) | `delegate` with `fixer`; `pantheon:designer` for UI |
| task reviewer and re-reviewer | `pantheon:oracle`, one dispatch per gate |
| final branch code reviewer | `pantheon:oracle`, a separate dispatch |
| parallel agents | several `delegate`/Agent calls in one message |

`executing-plans` stays in the main agent. The fixer never commits (Codex's sandbox makes `.git` read-only): the orchestrator commits and builds the review package.

## Security

- **Workspace**: a `delegate` `cwd` must resolve, symlinks followed, inside the session's repository root (or the session directory outside a repository). `resume` always reuses the job's stored `cwd` and checks it again.
- **Sandbox**: the effective one is the most restrictive of the role and `sandboxCap`; council seats are always read-only. Every run passes `-c sandbox_workspace_write.writable_roots=[]`, so extra writable roots in your `config.toml` do not widen writes. `/tmp` and `$TMPDIR` stay writable.
- **`--ignore-rules`**: every run ignores Codex `.rules` files, because an `allow` rule would run commands outside the sandbox. The cost: your `forbidden` rules do not apply inside Pantheon either; the sandbox still does.
- **Native agents** follow their tool list and the session's permission mode; `sandboxCap` and `noNetwork` do not apply to them.

## Develop

```
claude plugin validate plugins/pantheon
claude plugin test plugins/pantheon
claude --plugin-dir plugins/pantheon
```

`hooks/register.tsx` holds every hook and every `$` call. `tracking.ts` contains pure reducers for native subagents and the main session, plus tool-input redaction; `roster.ts` joins them with Codex jobs in the fixed role slots. `pane.tsx` draws the tabs and layouts, with `rail.tsx` and `elapsed.tsx` as surface modules for animation and clocks. Other host access is injected. The panel uses `pantheon.natives`, `pantheon.session` and `pantheon.view` alongside `pantheon.jobs` in `$.state`. `docs/design.md` and `docs/plan.md` preserve the original design and implementation history.

## Credits

The orchestrator, role and council prompts are adapted from [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) (MIT, see `LICENSE` and `NOTICE`).

The panel's rail, clock, native tracking and tool description/redaction code is adapted from Stephen Casella's work under the MIT License; see `NOTICE` for its provenance, adaptations and full license text.
