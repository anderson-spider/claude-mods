# Pantheon profiles: a configurable engine for every role

Date: 2026-10-08. Status: approved design, pending implementation plan.

## Goal

Every Pantheon role (explorer, librarian, fixer, oracle, designer) and every council seat can run on either engine, Codex (`delegate`) or Claude (a native `pantheon:<role>` agent). Engines and models are chosen through named profiles in the style of oh-my-opencode-slim's presets: the config names the active profile, and a profile holds each role's engine, model and effort. Three profiles ship with the plugin: `claude` (the default), `codex` and `mixed`. A selection menu is out of scope; this change is JSON only.

## Decisions

- Profiles are resolved inside `loadConfig`. The effective config already carries an `engine` on every role and seat, and every consumer (`roles.ts`, `roster.ts`, `pane.tsx`, the orchestrator prompt) reads `config.agents[role].engine`. No consumer knows about profiles.
- The default profile is `claude`. With no config file, explorer, librarian and fixer now run as native Claude agents instead of Codex. This is a breaking change: version 0.4.0, PR title `feat(pantheon)!`.
- A Codex sandbox follows the role, not the engine: oracle, explorer, librarian and council seats default to `read-only`; fixer and designer default to `workspace-write`. `sandboxCap` and `agents.<role>.sandbox` still narrow it.
- Profiles hold only `engine`, `model` and `effort`. `prompt`, `sandbox`, `sandboxCap`, `noNetwork`, `foregroundMinutes` and `disabledAgents` stay at the top level and apply to every profile.
- Engine/model pairs are validated when the config loads.

## 1. Config shape and resolution

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

- `profile` (string) names the active profile. Default `claude`. The project file overrides the user file, like every other field. An unknown name rejects the config: `profile: unknown profile "x"; known: claude, codex, mixed, …`.
- `profiles.<name>` holds `agents.<role>.{engine, model, effort}` and `council.seats.<seat>.{engine, model, effort}`. Any other key is rejected as an unknown field. User and project profiles merge field by field over the built-in ones (built-in, then user, then project). A new profile name starts empty and inherits every field it does not declare from the `claude` profile.
- A seat that a profile declares and that no built-in profile has needs an `engine` once resolved, as today.
- Top-level `agents.<role>` accepts only `prompt` and `sandbox`. `model`, `effort` or `engine` there reject the config with `agents.<role>.<field>: moved to profiles.<profile>.agents.<role>.<field>`.
- Top-level `council.seats.<seat>` accepts only `prompt`. Its `engine`, `model` and `effort` move to profiles the same way. A seat exists when the active profile or the top level declares it.
- Resolution: after merging every layer, the active profile's entries are applied to `agents` and `council.seats`, producing `PantheonConfig` with `engine`, `model` and `effort` on each role and seat. The effective config also records `profile` (the active name).
- `origins` records where each effective field came from: `default` for built-in profile values, `user` or `project` for values from those files, keyed by the effective path (`agents.oracle.model`) so `/pantheon config` keeps working. `profile` has its own origin.

### Engine/model validation

Run on the resolved active profile, after merging:

- Engine `claude` accepts `opus`, `sonnet`, `haiku`, `fable`, `inherit` or any id starting with `claude-`.
- Engine `codex` rejects those names and any `claude-` id, and accepts anything else.
- A role or seat with no `model` is valid on either engine (the engine picks its own default).
- A mismatch rejects the config with the field path and engine, for example `profiles.claude.agents.fixer.model: "gpt-6-astra" is not a Claude model (engine claude)`. The path names the profile layer that set the model when known, else the effective path.
- Behavior on rejection is unchanged: a toast, `delegate` refuses every call, and native agents stay as in the last valid config (or the defaults).

### Built-in profiles

| Role or seat | `claude` (default) | `codex` | `mixed` |
| --- | --- | --- | --- |
| explorer | claude `haiku` | codex `gpt-6-luna`, high | codex `gpt-6-luna`, high |
| librarian | claude `haiku` | codex `gpt-6-luna`, high | codex `gpt-6-luna`, high |
| fixer | claude `sonnet` | codex `gpt-6.1-sol`, high | codex `gpt-6.1-sol`, high |
| oracle | claude `opus` | codex `gpt-6-astra`, high | claude `opus` |
| designer | claude `sonnet` | codex `gpt-6.1-sol`, high | claude `sonnet` |
| seat alpha | claude `opus` | codex `gpt-6-astra`, high | codex `gpt-6-astra`, high |
| seat beta | claude `sonnet` | codex `gpt-6.1-sol`, high | claude `opus` |

`mixed` is exactly the 0.3.0 behavior. The built-in profiles live in `defaults.ts` next to `DEFAULT_CONFIG`, whose `agents` keep only the top-level defaults (sandbox per role).

## 2. How each role runs on each engine

### Engine `claude`

The role is the native agent `pantheon:<role>`, registered with `$.agent.register` and called through the `Agent` tool. Tools by role:

| Role | Tools |
| --- | --- |
| explorer, oracle, council seats | `Read`, `Grep`, `Glob` |
| librarian | `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` |
| fixer, designer | all (no `tools` list) |

`sandbox`, `sandboxCap` and `noNetwork` do not apply to native agents; they follow their tool list and the session's permission mode, as today.

### Engine `codex`

The role runs through `delegate` (`codex exec --json`). Default sandbox: `read-only` for explorer, librarian, oracle and council seats; `workspace-write` for fixer and designer. `agents.<role>.sandbox` and `sandboxCap: read-only` narrow it; a council seat is always `read-only`.

### Role prompts

The "File operations" line follows the engine rather than the role: the Codex text (rg, shell, apply_patch within the sandbox) for Codex, the native text (Read/Grep/Glob, Edit where offered) for Claude. Read-only roles keep the read-only wording on both engines.

### Wrong channel

- `delegate` for a role on `claude` returns `Use pantheon:<role> through the Agent tool.`; the error lists the roles currently on Codex.
- The `agent.offer` guard hides `pantheon:<role>` when the role is disabled or on `codex`. Registered agents cannot be unregistered, so this guard is what makes a profile switch mid-session take effect.
- `resume` accepts only a job whose role is on `codex` now; otherwise it returns the wrong-channel error.

### Orchestrator prompt

Each role's `Call:` line and the council line are generated from the effective engine: `delegate({ agent: "<role>", ... })` on Codex, `Agent({ subagent_type: "pantheon:<role>", ... })` on Claude. The Background Task Discipline and Session Reuse text names both channels generically, without assuming which roles are on which engine.

### Panel

- `jobSlot` and `nativeSlot` accept all five roles plus council seats.
- A slot's engine comes from the effective config. Instances keep the engine they ran on; a slot whose current instances span both engines shows `mixed`.
- `/pantheon config` shows the active profile and each effective field with its origin.

## 3. Testing, docs and version

Tests (TDD; each module has its mirror in `plugins/pantheon/tests/`):

- `config.test.ts`: default profile `claude`; project `profile` overrides user; profile merge over built-ins; a new profile inherits from `claude`; unknown profile rejected; `model`/`effort`/`engine` at the top level rejected with the migration message; engine/model pairs validated both ways, seats included; `origins` for profile fields.
- `roles.test.ts`: `resolveCodexCall` accepts oracle and designer on Codex with the role sandbox and the `sandboxCap` ceiling; refuses roles on Claude with the `Agent` hint; `nativeAgentSpecs` registers explorer, librarian and fixer when on Claude with the tool table; the file-ops line follows the engine.
- `offer.test.ts`: `pantheon:<role>` hidden when the role is on Codex.
- `orchestrator.test.ts`: `Call:` and council lines follow the engine; one assertion per built-in profile.
- `roster.test.ts`, `pane.test.ts`: all five roles as job or native; slot engine from config; `mixed` slot.
- `register.test.ts`: end to end with `codex` (oracle through `delegate`) and `claude` (explorer registered as native, its `delegate` refused).

Docs:

- `plugins/pantheon/README.md`: role table per profile, `profile`/`profiles` config with the example, pair validation, and a migration note from 0.3 (top-level `model`/`effort`/`engine` move into a profile; the default is now all Claude; `"profile": "mixed"` keeps the old behavior).
- `AGENTS.md`: the pantheon line mentions profiles and the per-role engine.

Version and delivery:

- `plugins/pantheon/.claude-plugin/plugin.json`: 0.3.0 → 0.4.0.
- Branch `andersonsilva/pantheon-profiles`; PR `feat(pantheon)!: select role engines and models through profiles`.
- Done: `claude plugin validate plugins/pantheon`, `claude plugin test plugins/pantheon`, `node scripts/check-consistency.mjs` and `node scripts/check-version-bump.mjs origin/main` pass.
- Out of the repository: the migrated `~/.claude/pantheon.json` (`profile: "mixed"`, fixer and oracle on `gpt-6-astra`, oracle on Codex) is handed to the user, not written.

## Out of scope

- A menu or slash command to switch profiles.
- Per-project profile switching beyond the existing project config file.
- New roles or seats.
