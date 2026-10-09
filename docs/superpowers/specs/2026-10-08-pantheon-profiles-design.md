# Pantheon profiles: a configurable engine for every role

Date: 2026-10-08. Status: approved design (revised after oracle review), pending implementation plan.

## Goal

Every Pantheon role (explorer, librarian, fixer, oracle, designer) and every council seat can run on either engine, Codex (`delegate`) or Claude (a native `pantheon:<role>` agent). Engines and models are chosen through named profiles in the style of oh-my-opencode-slim's presets: the config names the active profile, and a profile holds each role's engine, model and effort. Three profiles ship with the plugin: `claude` (the default), `codex` and `mixed`. A selection menu is out of scope; this change is JSON only.

## Decisions

- Profiles are resolved inside `loadConfig`. The effective config carries an `engine` on every role and seat, and every consumer (`roles.ts`, `roster.ts`, `tracking.ts`, `pane.tsx`, the orchestrator and superpowers prompts, the role prompts) reads `config.agents[role].engine`. No consumer knows about profiles.
- The default profile is `claude`. With no config file, explorer, librarian and fixer run as native Claude agents instead of Codex. Breaking change: version 0.4.0, PR title `feat(pantheon)!`.
- A Codex sandbox can only narrow: effective = the most restrictive of the role default, `agents.<role>.sandbox` and `sandboxCap`. Role defaults: `read-only` for explorer, librarian, oracle and council seats; `workspace-write` for fixer and designer. This drops 0.3's ability to widen explorer or librarian with `sandbox: "workspace-write"`.
- Profiles hold only `engine`, `model` and `effort`. `prompt`, `sandbox`, `sandboxCap`, `noNetwork`, `foregroundMinutes` and `disabledAgents` stay at the top level and apply to every profile.
- Validation (unknown profile, seat `engine`, engine/model pairs) runs once, after every layer is merged, over every profile, not only the active one.

## 1. Types

In `hooks/types.ts`:

```ts
export type Role = 'explorer' | 'librarian' | 'fixer' | 'oracle' | 'designer'
export type Engine = 'codex' | 'claude'
export interface RoleConfig { engine: Engine; model?: string; effort?: string; prompt?: string; sandbox?: Sandbox }
export interface Seat { engine: Engine; model?: string; effort?: string; prompt?: string }
export interface PantheonConfig {
  profile: string
  sandboxCap: Sandbox; noNetwork: boolean; foregroundMinutes: number; disabledAgents: string[]
  agents: Record<Role, RoleConfig>
  council: { seats: Record<string, Seat> }
}
export type PromptKey = Role | 'councillor'
export type RolePrompts = (key: PromptKey, engine: Engine) => string
```

`CodexRole`, `NativeRole`, `RoleOverride`, `CODEX_ROLES` and `NATIVE_ROLES` are removed; code that needs "roles on Codex" filters `config.agents` by engine. The effective config carries `profile` but not `profiles`, so `configReport`'s JSON and `registeredKey` stay small. `roster.ts` imports `Engine` from `types.ts` instead of declaring its own.

## 2. Config shape and resolution

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

### Defaults

`hooks/defaults.ts` exports:

- `BASE_DEFAULTS`: the top level (`sandboxCap`, `noNetwork`, `foregroundMinutes`, `disabledAgents`) and per-role `sandbox`.
- `BUILTIN_PROFILES`: `claude`, `codex`, `mixed` (table below), each with every role and the seats `alpha` and `beta`, all with an `engine`.
- `DEFAULT_CONFIG`: the resolved config of the `claude` profile with no files, frozen. It stays the initial state in `register.tsx`, the error fallback in `loadConfig` without `lastValid`, and the natives registered before any valid config.

| Role or seat | `claude` (default) | `codex` | `mixed` |
| --- | --- | --- | --- |
| explorer | claude `haiku` | codex `gpt-6-luna`, high | codex `gpt-6-luna`, high |
| librarian | claude `haiku` | codex `gpt-6-luna`, high | codex `gpt-6-luna`, high |
| fixer | claude `sonnet` | codex `gpt-6.1-sol`, high | codex `gpt-6.1-sol`, high |
| oracle | claude `opus` | codex `gpt-6-astra`, high | claude `opus` |
| designer | claude `sonnet` | codex `gpt-6.1-sol`, high | claude `sonnet` |
| seat alpha | claude `opus` | codex `gpt-6-astra`, high | codex `gpt-6-astra`, high |
| seat beta | claude `sonnet` | codex `gpt-6.1-sol`, high | claude `opus` |

`mixed` is exactly the 0.3.0 behavior, apart from the sandbox rule above.

### Fields

- `profile` (string) names the active profile. Default `claude`. The project file overrides the user file.
- `profiles.<name>` holds `agents.<role>.{engine, model, effort}` and `council.seats.<seat>.{engine, model, effort}`. Any other key is an unknown field.
- Top-level `agents.<role>` accepts only `prompt` and `sandbox` (every role, Codex or not). Top-level `council.seats.<seat>` accepts only `prompt`.
- `model`, `effort` or `engine` at the top level reject the config with a migration message naming the target path: `agents.fixer.model: moved to profiles.<p>.agents.fixer.model`, where `<p>` is the `profile` declared in the same file, else `claude`. Same for seats.

### Merge

Layers apply in order: built-in, user, project. Per layer:

1. Top-level fields merge as today (`sandboxCap` and `noNetwork` toward the most restrictive, `disabledAgents` as a union, `agents.<role>.{prompt,sandbox}` field by field, `council.seats.<seat>.prompt`).
2. `profile` replaces the current name.
3. Each `profiles.<name>.agents.<role>` and `profiles.<name>.council.seats.<seat>` merges field by field into the merged profile `<name>`. **Engine switch rule:** when the layer sets an `engine` different from the merged one, the merged `model` and `effort` are dropped unless the same layer declares them.

After all layers:

4. A profile name that is not built-in starts from the merged `claude` profile (built-in plus user and project changes to `claude`), then applies its own declared entries with the engine switch rule.
5. Validate every merged profile (below). Then check that `profile` names a known profile: `profile: unknown profile "x"; known: claude, codex, mixed, mine`.
6. Resolve: the active profile's role entries fill `agents.<role>.{engine, model, effort}`; its seats, plus seats declared only at the top level, form `council.seats`. A seat declared at the top level that the active profile lacks has no engine and rejects the config (`council.seats.<seat>.engine: required; declare it in profiles.<p>.council.seats.<seat>`).

### Validation

- A seat in any profile must have an `engine` after merge.
- Engine/model pairs, in every merged profile:
  - Engine `claude` accepts a model that is a Claude alias (`opus`, `sonnet`, `haiku`, `fable`, `opusplan`, `default`, `inherit`), optionally followed by a bracket suffix such as `[1m]`, or any id containing `claude` (covers `claude-*`, `us.anthropic.claude-*`, Bedrock ARNs).
  - Engine `codex` rejects exactly what engine `claude` accepts, and accepts anything else.
  - No `model` is valid on either engine.
- `effort` is not validated; the README notes that values differ per engine.
- Errors after the merge are prefixed by the file that set the offending field (from origins), or no prefix when the value is built-in: `/home/u/.claude/pantheon.json: profiles.claude.agents.fixer.model: "gpt-6-astra" is not a Claude model (engine claude)`.
- Errors during per-layer shape validation keep today's `${path}:` prefix.
- Behavior on rejection is unchanged: a toast, `delegate` refuses every call, and native agents stay as in the last valid config (or `DEFAULT_CONFIG`).

### Origins

During the merge, origins are kept per `(profile, field)` for profile fields and per path for top-level fields. After resolution they are projected onto effective paths (`agents.oracle.model`, `council.seats.beta.engine`, `profile`). Fields a new profile inherits from `claude` keep the origin they have in the merged `claude` (so built-in values stay `default`). Inactive profiles do not appear in the effective origins.

## 3. How each role runs on each engine

### Engine `claude`

The role is the native agent `pantheon:<role>`, registered with `$.agent.register` and called through `Agent`. `nativeAgentSpecs` builds a spec for every role and seat on `claude` that is not disabled.

| Role | Tools | Description |
| --- | --- | --- |
| explorer | `Read`, `Grep`, `Glob` | Pantheon codebase recon that returns compressed context. |
| librarian | `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` | Pantheon research on external docs and APIs. |
| fixer | all | Pantheon bounded implementation from a complete specification. |
| oracle | `Read`, `Grep`, `Glob` | (unchanged) |
| designer | all | (unchanged) |
| council seat | `Read`, `Grep`, `Glob` | (unchanged) |

Descriptions differ from the built-in `Explore` agent. Fixer and designer with all tools also receive `Agent` and `mcp__pantheon__delegate`; their prompts forbid sub-delegation, nothing else enforces it. `sandbox`, `sandboxCap` and `noNetwork` do not apply to native agents.

### Engine `codex`

The role runs through `delegate`. Sandbox per the decision above; a council seat is always `read-only`. `args.model` on a call is validated with the engine/model rule (a Claude alias for a Codex role is refused with the pair error).

### Role prompts

`rolePrompt(key, engine)` returns text per role and engine:

- File operations: Codex text (rg, shell, apply_patch within the sandbox; read-only roles: no writes) or native text (Read/Grep/Glob; Edit/Write/Bash where offered; read-only roles: no edits, no Bash).
- fixer on Codex keeps "Do not commit: .git is read-only". fixer on Claude gets "Do not commit or push; the orchestrator commits."
- designer gets a File operations line per engine; its native Constraints line is engine-neutral.
- oracle and councillor on Codex lose "do not run Bash" and get the Codex read-only text.
- librarian on Claude: the prompt names WebSearch/WebFetch and drops the documentation-MCP instruction.

### Wrong channel

- `delegate` for a role on `claude` returns `Use pantheon:<role> through the Agent tool.`. The "unknown or disabled" error lists the roles and seats currently on Codex.
- The `agent.offer` guard hides `pantheon:<role>` and `pantheon:councillor-<seat>` when disabled or on `codex`. Registered agents cannot be unregistered, so this guard is what makes a profile switch mid-session take effect; switching back re-registers through `registeredKey`.
- `resume`: `delegate` reads the job's agent through `resumeTarget`, then `resolveCodexCall` refuses it if that role is now on `claude`. No extra code beyond the engine check.

### Tool descriptions and doctor

- `delegate`, `delegate_result` and `delegate_cancel` descriptions become generic ("a Pantheon role or council seat currently on Codex"), since they are registered once at `session.start`. The `agent` field description says the same.
- `doctorReport` takes whether any role or seat in the effective config is on Codex. If none, missing Codex CLI or login shows `info` with "not needed by profile <p>" instead of `falha`.

### Orchestrator and superpowers prompts

- Orchestrator: each role's `Call:` line and the council line come from the effective engine (`delegate({ agent: "<role>", … })` or `Agent({ subagent_type: "pantheon:<role>", … })`). Background Task Discipline, Active Task Amendments and Session Reuse lines that name `delegate`, `delegate_result`, `delegate_cancel` or Codex resume appear only when at least one active role or seat is on Codex; native lines always appear.
- Superpowers (`prompts/superpowers.ts`): the implementer mapping uses fixer's engine (`delegate({ agent: "fixer", … })` or `Agent({ subagent_type: "pantheon:fixer", … })`); the UI implementer uses designer's; reviewers use oracle's (Codex oracle gets the review package path through the prompt and may read it with shell). The Codex implementer lines (one session per task with `resume`, ".git is read-only", "orchestrator commits") appear only when fixer is on Codex. When fixer is on Claude: "The implementer does not commit; the orchestrator commits, records the SHA, then generates the review package." "The native reviewer has no Bash" appears only when oracle is on Claude.

### Tracking and panel

- `tracking.roleOf` maps every `pantheon:<role>` of the five roles and `pantheon:councillor-<seat>`. `normalizeNatives` recomputes `role` from the stored `type`, so old `other` records of Pantheon agents land in their slot.
- `roster.ts`: `jobSlot` and `nativeSlot` accept all five roles plus seats. A role slot is `off` only when the role is in `disabledAgents`; the council slot is `off` when `council` is disabled or every seat is disabled. Seat `off` uses `disabledAgents` only, not `isOffered`.
- Slot engine: the role's engine from the config (for council: the seats' engines, `mixed` when they differ); the slot shows `mixed` when any displayed instance (active ones and the last ended one) ran on a different engine than that.
- `configReport` shows `Perfil ativo: <p> (<origin>)` above the JSON and lists non-default origins as today.

## 4. Testing

TDD; each module has its mirror in `plugins/pantheon/tests/`. Tests that today use `DEFAULT_CONFIG` to mean "explorer, librarian, fixer on Codex" switch to a `resolved('mixed')` fixture (a helper that runs `loadConfig` with `{"profile":"mixed"}`).

- `config.test.ts`:
  - default profile is `claude` and equals `DEFAULT_CONFIG`; the error fallback without `lastValid` is `DEFAULT_CONFIG`;
  - project `profile` overrides user; `profile: "mine"` in user with `mine` defined only in project is accepted;
  - profile merge over built-ins; a new profile inherits from the merged `claude`;
  - engine switch drops inherited `model` and `effort`, keeps those declared in the same layer;
  - unknown profile rejected after all layers;
  - top-level `model`/`effort`/`engine` (roles and seats) rejected with the migration message;
  - engine/model pairs both ways, seats included, aliases with `[1m]`, Bedrock ids; inactive profiles validated;
  - post-merge error prefix is the file that set the field;
  - origins: user changes `profiles.mixed`, project switches to `codex`, origins of the effective fields are `default`; `profile` origin recorded;
  - top-level `sandbox` accepted for oracle and designer.
- `roles.test.ts`: `resolveCodexCall` for oracle and designer on Codex with role sandbox; sandbox never widens (oracle `workspace-write` stays `read-only`, explorer `workspace-write` stays `read-only`); `sandboxCap` ceiling; refusal with the `Agent` hint for roles on Claude; `args.model` Claude alias refused on Codex; `nativeAgentSpecs` for explorer, librarian, fixer on Claude with tools and descriptions; prompts per engine (fixer commit line, oracle Bash line).
- `offer.test.ts`: `pantheon:<role>` and seats hidden when on Codex.
- `orchestrator.test.ts`: `Call:` and council lines per engine, one assertion per built-in profile; Codex-only discipline lines absent in `claude`.
- `superpowers.test.ts`: mappings and implementer lines per profile.
- `tracking.test.ts`: `roleOf` for the five roles; `normalizeNatives` recomputes `role`.
- `roster.test.ts`, `pane.test.ts`: five roles as job or native; slot engine from config; `mixed` from instances; oracle on Codex is not `off`; `configReport` shows the profile; doctor with profile `claude` and no Codex CLI.
- `register.test.ts`: end to end with `codex` (oracle through `delegate`) and `claude` (explorer registered as native, its `delegate` refused); profile switch mid-session (`claude` → `codex` hides `pantheon:explorer` and `delegate` accepts it; back re-registers); resume of a `fixer` job after fixer moved to `claude` returns the wrong-channel error.

## 5. Docs and version

- `plugins/pantheon/README.md`: intro and role table per profile; `profile`/`profiles` config with the example; pair validation and effort note; sandbox narrowing; Tools, Install ("Codex CLI needed only for roles on Codex"), Security and Superpowers sections updated; migration note from 0.3 with the exact JSON equivalent of 0.3 plus a customization (`{"profile":"mixed","profiles":{"mixed":{"agents":{"fixer":{"model":"…"}}}}}`), and that `"profile": "mixed"` keeps the old engines.
- `AGENTS.md`: rewrite the pantheon paragraph's role and roster sentences (profiles, per-role engine, five roles on either engine).
- `plugins/pantheon/.claude-plugin/plugin.json`: 0.3.0 → 0.4.0; description updated.

Delivery:

- Branch `andersonsilva/pantheon-profiles`; PR `feat(pantheon)!: select role engines and models through profiles`.
- Done: `claude plugin validate plugins/pantheon`, `claude plugin test plugins/pantheon`, `node scripts/check-consistency.mjs` and `node scripts/check-version-bump.mjs origin/main` pass.
- Out of the repository: the migrated `~/.claude/pantheon.json` (`profile: "mixed"`, fixer and oracle on `gpt-6-astra`, oracle on Codex) is handed to the user, not written.

## Out of scope

- A menu or slash command to switch profiles.
- New roles or seats.
- Enforcing "no sub-delegation" for native fixer and designer beyond their prompts.
