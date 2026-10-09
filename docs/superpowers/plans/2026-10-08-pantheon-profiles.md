# Pantheon Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every Pantheon role and council seat run on Codex or Claude, chosen through named profiles (`claude` default, `codex`, `mixed`) in the JSON config.

**Architecture:** `loadConfig` merges built-in, user and project layers, resolves the active profile and validates every profile, producing a `PantheonConfig` whose roles and seats each carry an `engine`. Every consumer (roles, prompts, tracking, roster, pane, register) reads that engine; none knows about profiles.

**Tech Stack:** TypeScript function-hooks mod for Claude Code; tests with `claude-code/testing` run by `claude plugin test plugins/pantheon`.

**Spec:** `docs/superpowers/specs/2026-10-08-pantheon-profiles-design.md`

## Global Constraints

- All paths below are under `plugins/pantheon/` unless they start with `docs/` or are `AGENTS.md`.
- Code comments, README and user-facing English text in English; existing Portuguese error/toast strings in `config.ts`, `roles.ts`, `pane.tsx` and `register.tsx` keep their language style (new messages follow the spec's exact English text where the spec gives it).
- Pure modules never touch `$`; every `$` call stays in `hooks/register.tsx`.
- Built-in profile values exactly as the spec table (§2 Defaults). `mixed` equals 0.3.0 engines/models/efforts.
- Claude aliases: `opus`, `sonnet`, `haiku`, `fable`, `opusplan`, `default`, `inherit`, each optionally followed by a `[...]` suffix; any id containing `claude` is a Claude model.
- Sandbox only narrows: effective = most restrictive of role default, `agents.<role>.sandbox`, `sandboxCap`. Council seats always `read-only`.
- Version `0.4.0` in `.claude-plugin/plugin.json`.
- No commit mentions AI; commits are Conventional Commits in English. Implementers do not commit; the orchestrator commits after each task.
- Run the suite with `claude plugin test plugins/pantheon` from the repo root; it must pass at the end of every task.

## Review Focus

- A user 0.3 config with top-level `agents.fixer.model` must fail with the migration message naming `profiles.claude.agents.fixer.model` (or the file's own `profile`), not a generic unknown-field error — test in Task 1.
- Switching a seat or role engine in a profile without giving a model must not inherit the other engine's model (the spec's own `mine` example must load) — test in Task 1.
- Switching `profile` mid-session from `claude` to `codex` and back must hide/re-offer native agents and route `delegate` accordingly without a restart — test in Task 5.
- A Codex job resumed after its role moved to Claude must be refused with the wrong-channel hint, not run — test in Task 5.
- `oracle.sandbox: "workspace-write"` must never give oracle write access on Codex — test in Task 2.

---

### Task 1: Types, built-in profiles and profile-aware `loadConfig`

**Files:**
- Modify: `hooks/types.ts:4-16,52-53`
- Modify: `hooks/defaults.ts` (rewrite)
- Create: `hooks/models.ts`
- Modify: `hooks/config.ts` (validation, merge, resolution, origins)
- Create: `tests/fixtures/profiles.ts`
- Create: `tests/models.test.ts`
- Modify: `tests/config.test.ts`, and the tests that use `DEFAULT_CONFIG` as "Codex roles": `tests/roles.test.ts`, `tests/offer.test.ts`, `tests/orchestrator.test.ts`, `tests/superpowers.test.ts`, `tests/council.test.ts`, `tests/pane.test.ts`

**Interfaces:**
- Produces (types.ts): `Role`, `Engine`, `RoleConfig`, `Seat`, `PantheonConfig` (with `profile: string`, `agents: Record<Role, RoleConfig>`), `PromptKey = Role | 'councillor'`, `RolePrompts = (key: PromptKey, engine: Engine) => string`, exactly as spec §1. Remove `CodexRole`, `NativeRole`, `RoleOverride`. Keep `CodexCall`, `DelegateArgs`, `ConfigResult`, `Origin` unchanged.
- Produces (defaults.ts): `ROLES: readonly Role[]` (`['explorer','librarian','fixer','oracle','designer']`), `ROLE_SANDBOX: Record<Role, Sandbox>` (read-only except fixer/designer workspace-write), `BASE_DEFAULTS` (top-level fields + `agents.<role>.sandbox`), `BUILTIN_PROFILES: Record<'claude'|'codex'|'mixed', ProfileEntries>`, `DEFAULT_CONFIG: PantheonConfig` (resolved `claude`, `Object.freeze`d deeply enough that tests cannot mutate it), where `type ProfileEntries = { agents: Record<Role, { engine: Engine; model?: string; effort?: string }>; council: { seats: Record<string, { engine?: Engine; model?: string; effort?: string }> } }`.
- Produces (models.ts): `isClaudeModel(model: string): boolean`; `modelMismatch(engine: Engine, model: string | undefined): string | undefined` returning `"<model>" is not a Claude model (engine claude)` or `"<model>" is a Claude model (engine codex)`, else `undefined`.
- Produces (config.ts): `loadConfig(read, paths, lastValid?)` with the same signature and `ConfigResult`, now profile-aware.
- Produces (fixtures/profiles.ts): `resolved(profile: 'claude' | 'codex' | 'mixed', extra?: object): Promise<PantheonConfig>` (runs `loadConfig` with `{ profile, ...extra }` as the user file and throws on error), and `MIXED`, `CODEX`, `CLAUDE` as top-level-awaited constants if the test runner supports top-level await; otherwise tests call `await resolved('mixed')` in each test.

- [ ] **Step 1: Write `tests/models.test.ts`**

```ts
test('Claude aliases, suffixes and ids', () => {
  for (const m of ['opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'default', 'inherit', 'opus[1m]', 'sonnet[1m]',
    'claude-opus-5-5', 'us.anthropic.claude-sonnet-5-5-v1:0', 'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-haiku-5-5'])
    expect(isClaudeModel(m)).toBe(true)
  for (const m of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'o9', 'opus-like']) expect(isClaudeModel(m)).toBe(false)
})
test('mismatch messages', () => {
  expect(modelMismatch('claude', 'gpt-6-astra')).toBe('"gpt-6-astra" is not a Claude model (engine claude)')
  expect(modelMismatch('codex', 'sonnet')).toBe('"sonnet" is a Claude model (engine codex)')
  expect(modelMismatch('codex', undefined)).toBeUndefined()
  expect(modelMismatch('claude', 'opus[1m]')).toBeUndefined()
})
```

- [ ] **Step 2: Write the new `tests/config.test.ts` cases** (replace the old "defaults when no files" assertion that fixer is `gpt-6.1-sol`):
  - `default profile is claude and equals DEFAULT_CONFIG`: `config.profile === 'claude'`, `agents.explorer` `{engine:'claude', model:'haiku', sandbox:'read-only'}`, `agents.librarian.model === 'haiku'`, `agents.fixer` `{engine:'claude', model:'sonnet', sandbox:'workspace-write'}`, `agents.oracle.model === 'opus'`, `agents.designer.model === 'sonnet'`, seats `alpha {engine:'claude', model:'opus'}`, `beta {engine:'claude', model:'sonnet'}`.
  - `built-in codex and mixed`: `load({profile:'codex'})` gives oracle `{engine:'codex', model:'gpt-6-astra', effort:'high'}`, designer `{engine:'codex', model:'gpt-6.1-sol', effort:'high'}`, beta `{engine:'codex', model:'gpt-6.1-sol', effort:'high'}`; `load({profile:'mixed'})` gives explorer `{engine:'codex', model:'gpt-6-luna', effort:'high'}`, fixer model `gpt-6.1-sol`, oracle `{engine:'claude', model:'opus'}`, alpha codex `gpt-6-astra` high, beta claude `opus`.
  - `error fallback without lastValid is DEFAULT_CONFIG`: `load('not json')`-style invalid → `result.config` toEqual `DEFAULT_CONFIG`.
  - `project profile overrides user`: user `{profile:'codex'}`, project `{profile:'mixed'}` → `profile === 'mixed'`.
  - `profile defined in project, named in user`: user `{profile:'mine'}`, project `{profiles:{mine:{agents:{oracle:{engine:'codex', model:'gpt-6-astra'}}}}}` → ok, oracle codex astra, explorer inherits claude `haiku`.
  - `profile edits merge over built-ins`: user `{profile:'mixed', profiles:{mixed:{agents:{fixer:{model:'gpt-6-astra'}}}}}` → fixer `{engine:'codex', model:'gpt-6-astra', effort:'high'}`.
  - `new profile inherits the merged claude`: user `{profiles:{claude:{agents:{explorer:{model:'sonnet'}}}, mine:{}}, profile:'mine'}` → explorer model `sonnet`.
  - `engine switch drops inherited model and effort`: the spec example `mine` (`council.seats.beta: {engine:'codex'}`) → ok, beta `{engine:'codex'}` with no model/effort; user `{profile:'mixed', profiles:{mixed:{agents:{oracle:{engine:'codex'}}}}}` → oracle has no `model`; `{..., oracle:{engine:'codex', model:'gpt-6-astra'}}` keeps it; `{profile:'codex', profiles:{codex:{agents:{explorer:{engine:'claude'}}}}}` drops `effort`.
  - `unknown profile`: `{profile:'nope'}` → error contains `profile: unknown profile "nope"; known: claude, codex, mixed`.
  - `top-level model, effort and engine moved to profiles`: `{agents:{fixer:{model:'gpt-6-astra'}}}` → error contains `agents.fixer.model: moved to profiles.claude.agents.fixer.model`; `{profile:'mixed', agents:{fixer:{effort:'low'}}}` → `moved to profiles.mixed.agents.fixer.effort`; `{council:{seats:{beta:{engine:'codex'}}}}` → `council.seats.beta.engine: moved to profiles.claude.council.seats.beta.engine`.
  - `top-level sandbox and prompt accepted for every role`: `{agents:{oracle:{sandbox:'workspace-write', prompt:'x'}, designer:{sandbox:'read-only'}}}` → ok, `agents.oracle.sandbox === 'workspace-write'` (narrowing happens in roles, Task 2).
  - `engine/model pairs both ways`: `{profiles:{claude:{agents:{fixer:{model:'gpt-6-astra'}}}}}` → error `u: profiles.claude.agents.fixer.model: "gpt-6-astra" is not a Claude model (engine claude)`; `{profile:'mixed', profiles:{mixed:{council:{seats:{alpha:{model:'opus'}}}}}}` → error mentions `profiles.mixed.council.seats.alpha.model` and `(engine codex)`; `opus[1m]` on claude ok.
  - `inactive profiles are validated`: `{profile:'claude', profiles:{codex:{agents:{oracle:{model:'opus'}}}}}` → rejected.
  - `post-merge error prefix is the file that set the field`: same mismatch set in project file `p` → error starts with `p: `.
  - `new seat needs an engine`: `{profiles:{claude:{council:{seats:{gamma:{model:'opus'}}}}}}` → error contains `council.seats.gamma.engine`; `{council:{seats:{gamma:{prompt:'x'}}}}` with no profile entry → error contains `council.seats.gamma.engine: required; declare it in profiles.claude.council.seats.gamma`.
  - `origins`: user `{profiles:{mixed:{agents:{fixer:{model:'gpt-6-astra'}}}}}`, project `{profile:'codex'}` → `origins['agents.fixer.model'] === 'default'`, `origins.profile === 'project'`; user `{profile:'mixed', profiles:{mixed:{agents:{fixer:{model:'gpt-6-astra'}}}}}` → `origins['agents.fixer.model'] === 'user'`; no key starting with `profiles.`.
  - Keep every existing case that still holds (sandboxCap/noNetwork restrictiveness, disabledAgents union, unknown fields, invalid JSON, lastValid fallback), rewriting its config to the new shape.

- [ ] **Step 3: Run tests, expect failures**

Run: `claude plugin test plugins/pantheon`
Expected: `models.test.ts` fails (module missing); new `config.test.ts` cases fail.

- [ ] **Step 4: Implement `hooks/models.ts`** with the regex rule: Claude when `/claude/i` matches, or the model with a trailing `\[[^\]]*\]` removed is one of the aliases.

- [ ] **Step 5: Implement `hooks/types.ts` and `hooks/defaults.ts`** per Interfaces. `DEFAULT_CONFIG` is computed from `BASE_DEFAULTS` + `BUILTIN_PROFILES.claude` (a small pure `applyProfile` helper exported from `config.ts` may build it; avoid an import cycle by putting that helper in `defaults.ts` or a new `hooks/profiles.ts`).

- [ ] **Step 6: Implement `loadConfig`** following spec §2 Merge steps 1–6 and Validation/Origins:
  - Per-layer shape validation (`validate`): new known keys `profile` (non-empty string) and `profiles` (object of objects with only `agents`/`council.seats`, entries with only `engine`/`model`/`effort`, `engine` ∈ codex|claude); top-level `agents.<role>` allows `prompt`, `sandbox` (every role); top-level `council.seats.<seat>` allows `prompt`; `model`/`effort`/`engine` at top level throw the migration message using the layer's own `profile` or `claude`. Errors here keep the `${path}:` prefix.
  - Merged profiles: a `Map<name, ProfileEntries>` seeded from `BUILTIN_PROFILES`, plus `Map<string, Origin>` keyed `name|agents.<role>.<field>` / `name|council.seats.<seat>.<field>`, and the source file path per key for error prefixes. Engine switch rule applied per layer.
  - Non-built-in names: after all layers, start from a copy of merged `claude` (with its origins) and re-apply that profile's declared entries with the switch rule.
  - Validate all merged profiles (seat engine required, `modelMismatch`), then the active name, then resolve. Remove today's per-layer seat-engine loop at `config.ts:159-163`.
  - Project origins onto effective paths; `origins.profile` is `default` unless a file set it.

- [ ] **Step 7: Create `tests/fixtures/profiles.ts`** and switch tests that assumed Codex roles under `DEFAULT_CONFIG` (`roles.test.ts`, `offer.test.ts`, `orchestrator.test.ts`, `superpowers.test.ts`, `council.test.ts`, `pane.test.ts`) to `await resolved('mixed')`. Do not change their assertions in this task; `roles.ts` still uses its fixed role lists and must keep passing. Update `roles.ts`/`roster.ts` imports only as needed for the removed types (`CODEX_ROLES`/`NATIVE_ROLES` stay local to `roles.ts` until Task 2, typed with `Role`).

- [ ] **Step 8: Run the suite**

Run: `claude plugin test plugins/pantheon`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add plugins/pantheon/hooks plugins/pantheon/tests
git commit -m "feat(pantheon): resolve role engines and models from config profiles"
```

---

### Task 2: Roles, sandbox, native specs, offer guard and per-engine role prompts

**Files:**
- Modify: `hooks/roles.ts`
- Modify: `hooks/prompts/roles.ts`
- Modify: `tests/roles.test.ts`, `tests/offer.test.ts`
- Modify: `tests/fixtures/world.ts` (default user config `{"profile":"mixed"}` at `${HOME}/.claude/pantheon.json` when `opts.files` does not set that path), `hooks/register.tsx:232,273` only if the `rolePrompt` signature change requires it (it is passed through; `nativeAgentSpecs`/`resolveCodexCall` call it with the engine)

**Interfaces:**
- Consumes: `PantheonConfig`, `Role`, `Engine`, `RolePrompts` (Task 1), `ROLES`, `ROLE_SANDBOX` (defaults.ts), `modelMismatch` (models.ts).
- Produces (roles.ts): `resolveCodexCall(config, args, ctx, prompts): CodexCall | { error: string }` (same signature); `nativeAgentSpecs(config, prompts): NativeSpec[]`; `isOffered(config, agentType): boolean`; `activeSeats(config): string[]` (unchanged); `codexAgents(config): string[]` (exported rename of `validCodexAgents`: active roles on Codex then `councillor:<seat>` of active Codex seats); `usesCodex(config): boolean` (any active role or active seat on Codex). Remove `CODEX_ROLES`, `NATIVE_ROLES`.
- Produces (prompts/roles.ts): `rolePrompt: RolePrompts` with `(key, engine)`.

- [ ] **Step 1: Write failing tests in `tests/roles.test.ts`**
  - `roles route by engine`: with `await resolved('codex')`, `call(cfg, 'oracle').sandbox === 'read-only'`, `call(cfg, 'designer').sandbox === 'workspace-write'`, `call(cfg,'explorer').model === 'gpt-6-luna'`; with `await resolved('claude')`, `resolveCodexCall(cfg, {agent:'explorer', prompt:'t'}, ctx, prompts)` equals `{ error: 'Use pantheon:explorer through the Agent tool.' }`.
  - `sandbox never widens`: codex profile with `agents.oracle.sandbox:'workspace-write'` → `read-only`; mixed with `agents.explorer.sandbox:'workspace-write'` → `read-only`; mixed with `agents.fixer.sandbox:'read-only'` → `read-only`; mixed with `sandboxCap:'read-only'` → fixer `read-only`; seats always `read-only`.
  - `per-call model must fit the engine`: mixed, `{agent:'fixer', prompt:'t', model:'sonnet'}` → error contains `"sonnet" is a Claude model (engine codex)`.
  - `unknown agent lists Codex agents`: claude profile, `{agent:'nope'}` → error contains `nenhum`; mixed → contains `explorer, librarian, fixer, councillor:alpha`.
  - `native specs follow the engine`: claude profile → names `explorer, librarian, fixer, oracle, designer, councillor-alpha, councillor-beta`; explorer tools `['Read','Grep','Glob']`, description `Pantheon codebase recon that returns compressed context.`; librarian tools `['Read','Grep','Glob','WebSearch','WebFetch']`, description `Pantheon research on external docs and APIs.`; fixer has no `tools`, description `Pantheon bounded implementation from a complete specification.`, model `sonnet`; codex profile → `[]`; mixed → `oracle, designer, councillor-beta`.
  - `prompts get the engine`: with `prompts = (k, e) => \`<${k}:${e}>\``, claude-profile explorer spec prompt starts with `<explorer:claude>`; codex-profile oracle call prompt starts with `<oracle:codex>`.
- [ ] **Step 2: Write failing tests in `tests/offer.test.ts`**: claude profile offers `pantheon:explorer`, `pantheon:librarian`, `pantheon:fixer`; codex profile hides `pantheon:oracle`, `pantheon:designer`, `pantheon:councillor-beta`; mixed hides `pantheon:fixer` and offers `pantheon:oracle`; `disabledAgents:['explorer']` hides `pantheon:explorer` on claude.
- [ ] **Step 3: Write failing tests for `rolePrompt`** (in `tests/roles.test.ts` or a new `tests/role-prompts.test.ts`):
  - `rolePrompt('fixer','codex')` contains `.git is read-only`; `rolePrompt('fixer','claude')` contains `Do not commit or push; the orchestrator commits.` and not `.git is read-only`.
  - `rolePrompt('oracle','codex')` does not contain `do not` + `run Bash` and contains `rg`; `rolePrompt('oracle','claude')` contains `Read/Grep/Glob`.
  - `rolePrompt('librarian','claude')` contains `WebSearch` and `WebFetch`.
  - `rolePrompt('designer', e)` contains a `**File operations**` line for both engines.
  - Every `(key, engine)` ends with the report-override sentence.
- [ ] **Step 4: Run tests, expect failures** (`claude plugin test plugins/pantheon`).
- [ ] **Step 5: Implement `roles.ts`**: engine checks replace the fixed role lists; `isOffered` returns false for `pantheon:<role>` on Codex; sandbox = most restrictive of `ROLE_SANDBOX[role]`, `agents[role].sandbox`, `config.sandboxCap`; validate the effective model (`args.model ?? role model`) with `modelMismatch('codex', …)`.
- [ ] **Step 6: Implement `prompts/roles.ts`**: split each role's file-ops/commit text into per-engine variants (constants `CODEX_READ_ONLY`, `CODEX_WRITE`, `NATIVE_READ_ONLY`, `NATIVE_WRITE`, fixer commit lines per spec §3 Role prompts); keep the rest of each prompt shared.
- [ ] **Step 7: Update `tests/fixtures/world.ts`** so existing `register.test.ts` scenarios that delegate to explorer/fixer keep running under `mixed`.
- [ ] **Step 8: Run the suite**: all pass.
- [ ] **Step 9: Commit** `feat(pantheon): route each role by its configured engine`.

---

### Task 3: Orchestrator and superpowers prompts follow the engine

**Files:**
- Modify: `hooks/prompts/orchestrator.ts`, `hooks/prompts/superpowers.ts`
- Modify: `tests/orchestrator.test.ts`, `tests/superpowers.test.ts`

**Interfaces:**
- Consumes: `PantheonConfig` (Task 1), `usesCodex`, `activeSeats` (Task 2).
- Produces: `buildOrchestratorSection(config): string`, `buildSuperpowersBlock(config): string` (same signatures).

- [ ] **Step 1: Write failing tests in `tests/orchestrator.test.ts`**, one per profile:
  - claude: contains `Agent({ subagent_type: "pantheon:explorer"` and `pantheon:fixer`; does not contain `delegate(`, `delegate_result` or `delegate_cancel`; council line `Agent pantheon:councillor-alpha, Agent pantheon:councillor-beta`.
  - codex: contains `delegate({ agent: "oracle"` and `delegate({ agent: "designer"`; does not contain `pantheon:oracle`; council line `delegate councillor:alpha, delegate councillor:beta`.
  - mixed: identical `Call:` lines to 0.3 (explorer/librarian/fixer `delegate`, oracle/designer `Agent`).
- [ ] **Step 2: Write failing tests in `tests/superpowers.test.ts`**:
  - claude: implementer line contains `Agent({ subagent_type: "pantheon:fixer"`; contains `The implementer does not commit; the orchestrator commits, records the SHA, then generates the review package.`; does not contain `resume: <jobId>` or `.git is read-only`; contains `The native reviewer has no Bash.`
  - codex: implementer `delegate({ agent: "fixer"`; UI implementer `delegate({ agent: "designer"`; reviewer lines name `delegate` with oracle; contains `.git is read-only`; does not contain `The native reviewer has no Bash.`
  - mixed: same text as 0.3 for every line.
- [ ] **Step 3: Run tests, expect failures.**
- [ ] **Step 4: Implement**: a `callLine(role, engine, desc, promptHint)` helper in `orchestrator.ts` builds each `Call:` line; Codex-only discipline lines (`delegate(... background: true)`, `delegate_result`, `delegate_cancel`, Codex resume in Session Reuse) included only when `usesCodex(config)`; native lines always. Superpowers mappings chosen by each role's engine per spec §3.
- [ ] **Step 5: Run the suite**: all pass.
- [ ] **Step 6: Commit** `feat(pantheon): build orchestrator and superpowers routing from role engines`.

---

### Task 4: Tracking, roster and pane follow the engine

**Files:**
- Modify: `hooks/tracking.ts:12-17,99`
- Modify: `hooks/roster.ts:1-6,66-76,81-145`
- Modify: `hooks/pane.tsx:27-55`
- Modify: `tests/tracking.test.ts`, `tests/roster.test.ts`, `tests/pane.test.ts`

**Interfaces:**
- Consumes: `Engine`, `PantheonConfig`, `ROLES` (Tasks 1–2), `usesCodex` (Task 2).
- Produces: `roleOf(type): string` (five roles + councillor); `normalizeNatives(raw)` recomputing `role` from `type`; `buildRoster(input)` (same signature); `configReport(state)`; `DoctorFacts` gains `usesCodex: boolean` and `profile: string`; `doctorReport(facts)`.

- [ ] **Step 1: Write failing tests**:
  - `tracking.test.ts`: `roleOf('pantheon:explorer') === 'explorer'` for all five roles; `roleOf('Explore') === 'other'`; `normalizeNatives([{ id:'a', role:'other', type:'pantheon:fixer', ... }])[0].role === 'fixer'`.
  - `roster.test.ts`: codex profile with a running `oracle` job → oracle slot `engine:'codex'`, `state:'active'`; codex profile oracle slot with no work is `idle`, not `off`; claude profile native `pantheon:explorer` lands in explorer slot (`others` empty); mixed config with explorer slot showing one Codex instance and one native ended instance → `engine:'mixed'`; `disabledAgents:['oracle']` → oracle `off`; council off only when `council` disabled or all seats disabled.
  - `pane.test.ts`: `configReport` first lines include `Perfil ativo: codex (user)`; `doctorReport({ usesCodex:false, profile:'claude', loginOk:false, config, root, isRepo:true })` has no `falha` line and contains `not needed by profile claude`; with `usesCodex:true` and no codex version, still `falha`.
- [ ] **Step 2: Run tests, expect failures.**
- [ ] **Step 3: Implement** per spec §3 Tracking and panel: `jobSlot`/`nativeSlot` accept every role in `ROLES`; slot engine = role engine (council: seats' engines, `mixed` if they differ) overridden to `mixed` when a displayed instance's engine differs; `off` from `disabledAgents` only; seat off from `disabledAgents` only (drop `isOffered` import from `roster.ts`).
- [ ] **Step 4: Run the suite**: all pass.
- [ ] **Step 5: Commit** `feat(pantheon): track and show every role on either engine`.

---

### Task 5: Register wiring, tool descriptions and end-to-end profile tests

**Files:**
- Modify: `hooks/register.tsx:86-88,309-325,572-590`
- Modify: `tests/register.test.ts`

**Interfaces:**
- Consumes: everything above. `doctorReport` facts now include `usesCodex(state.config)` and `state.config.profile`.

- [ ] **Step 1: Write failing tests in `tests/register.test.ts`**:
  - `codex profile delegates oracle`: world files `{ "${HOME}/.claude/pantheon.json": '{"profile":"codex"}' }`; a `delegate` call with `agent:'oracle'` runs Codex (argv recorded, `--sandbox read-only`); no `pantheon:oracle` registered in `seen.agents`.
  - `claude profile registers explorer natively and refuses its delegate`: files `{}` → `seen.agents` includes `explorer`, `librarian`, `fixer`; `delegate` with `agent:'explorer'` returns `Use pantheon:explorer through the Agent tool.`; `agent.offer` for `pantheon:explorer` is offered.
  - `profile switch mid-session`: start with `{"profile":"claude"}`, then rewrite the file to `{"profile":"codex"}`, run a turn → `agent.offer` hides `pantheon:explorer` and `delegate` explorer runs Codex; rewrite back to claude → explorer offered again and re-registered.
  - `resume after engine change`: under mixed, run a fixer job to completion; switch to `{"profile":"claude"}`; `delegate({ agent:'fixer', resume:<jobId>, prompt:'x' })` returns `Use pantheon:fixer through the Agent tool.`
  - `tool descriptions are generic`: the registered `delegate` description does not contain `explorer, librarian, fixer`.
  - `/pantheon doctor` under claude profile with no codex on PATH shows `not needed by profile claude`.
- [ ] **Step 2: Run tests, expect failures.**
- [ ] **Step 3: Implement**: generic descriptions (`Run a Pantheon role or council seat currently on Codex on a task …`; schema `agent`: `A role or councillor:<seat> currently on Codex.`); pass `usesCodex` and `profile` to `doctorReport`; doctor skips `codex login status` failure when `!usesCodex`.
- [ ] **Step 4: Run the suite**: all pass.
- [ ] **Step 5: Commit** `feat(pantheon): wire profiles through register and doctor`.

---

### Task 6: Docs, version and final checks

**Files:**
- Modify: `README.md` (plugin), `.claude-plugin/plugin.json`, repo `AGENTS.md`

- [ ] **Step 1: Update `plugins/pantheon/README.md`** per spec §5: intro, role table per profile (copy the spec table), config section with `profile`/`profiles` and the spec example, validation and effort note, sandbox narrowing, Tools/Install/Security/Superpowers sections, migration note from 0.3 with `{"profile":"mixed","profiles":{"mixed":{"agents":{"fixer":{"model":"…"}}}}}`.
- [ ] **Step 2: Update `AGENTS.md`** pantheon paragraph: replace "Codex roles (explorer, librarian, fixer, Codex council seats) run through `delegate`… native roles (`pantheon:oracle`, `pantheon:designer`, Claude council seats)…" with profiles (`claude` default, `codex`, `mixed`) choosing each role's and seat's engine; `config.ts` resolves profiles; `models.ts` validates engine/model pairs.
- [ ] **Step 3: Bump `plugin.json`** to `0.4.0`; description: `Makes Claude an orchestrator that delegates to specialist roles on Codex or native Claude agents, chosen per profile, with an auto-opening /pantheon panel for roles, activity and jobs.`
- [ ] **Step 4: Run the checks** (repo root):

```bash
claude plugin validate plugins/pantheon
claude plugin test plugins/pantheon
node scripts/check-consistency.mjs
node scripts/check-version-bump.mjs origin/main
```
Expected: all succeed. If `check-consistency` compares marketplace descriptions, update `.claude-plugin/marketplace.json` to match.
- [ ] **Step 5: Commit** `docs(pantheon): document profiles and bump to 0.4.0`.
