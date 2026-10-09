# Pantheon Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/pantheon` becomes the live dashboard of the Pantheon team (seven role slots, Jobs tab, mini and desktop layouts, flightdeck-style motion) and the flightdeck plugin is removed.

**Architecture:** Pure modules (`tracking.ts`, `roster.ts`) hold every rule; `register.tsx` feeds them from hook events and writes three new `$.state` keys through latest-snapshot queues; `pane.tsx` draws from `roster.ts`'s output; `rail.tsx` and `elapsed.tsx` are surface modules ported from flightdeck.

**Tech Stack:** Claude Code function-hook mods (TypeScript/TSX, `claude-code` and `claude-code/testing`), no build. API reference: `plugin-authoring` skill and its `types/claude-code.d.ts`.

**Spec:** `docs/superpowers/specs/2026-10-08-pantheon-panel-design.md`

## Global Constraints

- Work only in `/Users/andersonsilva/.herdr/worktrees/claude-mods/pantheon-panel` on branch `andersonsilva/pantheon-panel`. Implementers do not commit; the orchestrator commits after review.
- Panel text is English. Existing Portuguese texts of `/pantheon config`, `doctor`, `cancel`, tool replies and toasts stay as they are.
- Code comments in English (repo convention), matching the surrounding density.
- Pure modules never touch `$`. Every literal `$.noun.method(...)` and every `on(...)` lives in `hooks/register.tsx`.
- Every tracking hook returns the event's own result unchanged (`return next(e)` or the value `next` resolved to); tracking errors are caught and never reach the call.
- `pantheon.natives` holds at most 24 records; the oldest leave first.
- Fixed slot order: orchestrator, explorer, librarian, fixer, oracle, designer, council.
- Rail: step every 110 ms, two packets (`●` head, `•` trail) per 24 cells. Pulse: every 600 ms. Clock: 1 s tick.
- Mini: at most 8 lines; more than six active roles collapse into `+N`.
- Pantheon version `0.3.0`.
- Design reference (round 1, read-only HTML): `/private/tmp/claude-501/-Users-andersonsilva--herdr-worktrees-claude-mods-worktree-lucky-harbor-5264/61c6e523-76b3-4f9f-ad48-05f8bc2fe4da/scratchpad/pantheon-canvas/project/{Main,TerminalJobs,TerminalMini,Desktop,DesktopJobs}.dc.html`. Ignore every `Proposal*.dc.html`.

## Decision recorded during planning: native rounds

The engine types (`AgentStatus` doc) say an ended subagent "may yet resume, under the same id", so the spec's assumption holds: a `SendMessage` continuation keeps the `agentId`. But `turn.start` is never raised for a subagent ("a subagent's run raises no `turn.start`, its steps carry it"). Rounds therefore open on `turn.step`: a step whose `agentId` is known and whose `turnId` differs from the last round's `turnId` while that round has ended opens a new round. `turn.complete` (which carries `agentId` and `turnId`) closes it. Plan B of the spec is not needed.

## Review Focus

1. A subagent continued by `SendMessage` after its first round ended: same line, `↻ round 2`, clock restarts from the new round. (Task 1 test `a step with a new turnId after the round ended opens round 2`.)
2. A reload while a native round and a Codex job run: both become lost, the panel keeps drawing. (Task 1 `markNativesLost`, Task 4 `reload marks running native rounds lost`.)
3. State saved in an old or broken shape (`natives` not an array, a record missing `rounds`): normalized, no throw. (Task 1 `normalizeNatives drops broken records`.)
4. Secrets in a subagent's tool input (Bash with a token) must not reach `$.state`. (Task 1 `describeTool redacts secrets`.)
5. A narrow pane (40 columns) or a short one (10 rows): no line overflows the width; idle/off rows are dropped from the bottom before active ones. (Task 5 `docked at 40 columns truncates`.)

---

### Task 1: Types and tracking reducers

**Files:**
- Modify: `plugins/pantheon/types/index.d.ts`
- Create: `plugins/pantheon/hooks/tracking.ts`
- Test: `plugins/pantheon/tests/tracking.test.ts`

**Interfaces:**
- Produces (in `types/index.d.ts`, exported, and added to `PluginState.pantheon`):
  ```ts
  export type RoundStatus = 'running' | 'done' | 'failed' | 'stopped' | 'lost'
  export type Round = { turnId?: string; startedAt: number; endedAt?: number; status: RoundStatus }
  export type Native = {
    id: string; role: string; type: string; task: string; model: string
    rounds: Round[]; ctx: number; out: number; steps: number; lastTool?: string
  }
  export type SessionInfo = {
    model?: string; effort?: string
    context?: { tokens: number | null; window: number; percent: number | null }
    isRunning: boolean; turnStartedAt?: number; lastTurnMs?: number
  }
  export type PanelView = { tab: 'agents' | 'jobs' }
  // PluginState: pantheon: { jobs: Job[]; natives: Native[]; session: SessionInfo; view: PanelView }
  ```
  `hooks/types.ts` re-exports `Native`, `Round`, `RoundStatus`, `SessionInfo`, `PanelView`.
- Produces (in `hooks/tracking.ts`):
  - `MAX_NATIVES = 24`, `DEFAULT_SESSION: SessionInfo = { isRunning: false }`, `DEFAULT_VIEW: PanelView = { tab: 'agents' }`
  - `roleOf(subagentType: string): string` — `pantheon:oracle` → `oracle`, `pantheon:designer` → `designer`, `pantheon:councillor-<seat>` → `councillor-<seat>`, anything else → `other`.
  - `spawned(list: Native[], s: { id: string; type: string; task: string; model: string; now: number }): Native[]` — appends one record with one running round (`startedAt: now`, no `turnId`), ctx/out/steps 0; drops an existing record with the same id first; keeps the last 24.
  - `stepped(list: Native[], s: { id: string; turnId: string; now: number; usage?: StepUsage }): Native[]` where `StepUsage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number }`. Unknown id → same array. Last round running without `turnId` → set its `turnId`. Last round ended and `turnId` differs → push `{ turnId, startedAt: now, status: 'running' }`. Then `steps + 1`, `ctx` = input + cache read + cache creation when > 0 (else keep), `out += output_tokens`.
  - `toolNoted(list: Native[], id: string, text: string): Native[]`
  - `completed(list: Native[], c: { id: string; reason: string; now: number }): Native[]` — closes the last running round: `answer` → `done`, `aborted` → `stopped`, anything else → `failed`, `endedAt: now`.
  - `markNativesLost(list: Native[]): Native[]` — every running round → `lost` (endedAt untouched).
  - `normalizeNatives(raw: unknown): Native[]`, `normalizeSession(raw: unknown): SessionInfo`, `normalizeView(raw: unknown): PanelView` — wrong shapes become defaults; records without a string `id` or an array `rounds` are dropped; numeric fields default to 0.
  - `sessionStarted(s: SessionInfo, now: number)`, `sessionCompleted(s: SessionInfo, durationMs: number)`, `sessionStepped(s: SessionInfo, model: string, effort: string | undefined)`, `sessionMeasured(s: SessionInfo, context: { tokens?: number | null; window: number; percent?: number | null })`, each returning `SessionInfo`.
  - `describeTool(tool: string, input: unknown): string` — port of flightdeck `describeInput` + `redact` (`plugins/flightdeck/hooks/core.ts:249-282`) but formatted `Read pantheon/hooks/jobs.ts` (tool, space, last two path segments / command / pattern / url / description), cut to 64 chars with `…`.

- [ ] **Step 1: Write the failing tests** in `tests/tracking.test.ts` (`import { expect, test } from 'claude-code/testing'`):
  - `roleOf maps pantheon types and others`: `roleOf('pantheon:oracle')==='oracle'`, `roleOf('pantheon:councillor-beta')==='councillor-beta'`, `roleOf('Explore')==='other'`.
  - `spawn creates a record with one running round`.
  - `steps add tokens and steps`: two steps with `{input_tokens:10, cache_read_input_tokens:90, output_tokens:5}` → `ctx 100, out 10, steps 2`.
  - `a step with a new turnId after the round ended opens round 2`: spawn, step t1, complete answer, step t2 → `rounds.length 2`, `rounds[1].status 'running'`, `rounds[0].status 'done'`.
  - `a step with the same turnId does not open a round`.
  - `complete maps reasons`: answer→done, aborted→stopped, error→failed.
  - `the list keeps 24 records`: 30 spawns → length 24, first id is the 7th.
  - `markNativesLost turns running rounds into lost`.
  - `normalizeNatives drops broken records`: `normalizeNatives('x')` → `[]`; `[{id:'a'}, {id:'b', rounds:[]}]` → one record `b` with ctx 0.
  - `describeTool redacts secrets`: `describeTool('Bash', { command: 'curl -H "Authorization: Bearer abc.def.ghi123" x' })` does not contain `abc.def`; `describeTool('Read', { file_path: '/a/pantheon/hooks/jobs.ts' })==='Read hooks/jobs.ts'`.
  - `session reducers`: started → isRunning true and turnStartedAt; completed → false and lastTurnMs.
- [ ] **Step 2: Run** `claude plugin test plugins/pantheon` — expect the new tests to FAIL (module missing).
- [ ] **Step 3: Implement** the types and `hooks/tracking.ts` per the Interfaces block.
- [ ] **Step 4: Run** `claude plugin test plugins/pantheon` — all PASS; `claude plugin validate plugins/pantheon` passes.
- [ ] **Step 5: Commit** (orchestrator): `feat(pantheon): add native subagent and session tracking reducers`

### Task 2: Roster

**Files:**
- Create: `plugins/pantheon/hooks/roster.ts`
- Test: `plugins/pantheon/tests/roster.test.ts`

**Interfaces:**
- Consumes: `Job` (`types/index.d.ts`), `Native`, `SessionInfo`, `PantheonConfig`, `isOffered` (`hooks/roles.ts`).
- Produces:
  ```ts
  export const ROLE_ORDER = ['orchestrator', 'explorer', 'librarian', 'fixer', 'oracle', 'designer', 'council'] as const
  export type SlotName = (typeof ROLE_ORDER)[number]
  export type Engine = 'claude' | 'codex'
  export type RoundView = { startedAt: number; endedAt?: number; status: string }
  export type Instance = {
    id: string           // job id (first job of the session line) or native id
    engine: Engine
    seat?: string        // council seat name
    task: string
    model?: string
    status: string       // running | background | done | error | cancelled | lost | failed | stopped
    isActive: boolean
    startedAt: number    // current round's start
    endedAt?: number
    rounds: RoundView[]  // ≥ 1
    activity?: string    // Codex lastActivity or native lastTool
    tokens: { input?: number; cached?: number; out: number; ctx?: number; steps?: number }
    resumeId?: string    // latest job id of a resumable Codex line
  }
  export type Slot = {
    name: SlotName; engine: Engine | 'mixed'; state: 'active' | 'idle' | 'off'
    model?: string; instances: Instance[]   // active instances first, then the latest ended one
    lastEndedAt?: number; offReason?: string  // 'disabledAgents'
    seatsOff?: string[]                       // council: seats off while the slot is on
  }
  export type Roster = { slots: Slot[]; others: Instance[]; delegating: SlotName[]; counts: { active: number; idle: number; off: number } }
  export function buildRoster(input: { jobs: Job[]; natives: Native[]; session: SessionInfo; config: PantheonConfig }): Roster
  export function ago(ms: number): string  // '12s', '12m', '3h'
  ```
- Rules: Codex jobs map by `agent` (`explorer`/`librarian`/`fixer`, `councillor:<seat>` → council); jobs sharing a `sessionId` collapse into one Instance whose rounds are those jobs in `startedAt` order, `id` of the first job, status/tokens/activity of the latest. Natives map by `role` (`councillor-<seat>` → council, `other` → `others`). The orchestrator slot is always `active` when `session.isRunning`, else `idle`, never off; its `model` is `session.model`. A slot is `off` when `!isOffered(config, 'pantheon:<role>')` for natives or the role is in `config.disabledAgents` for Codex; council is off when `council` is disabled or every seat is; single disabled seats go to `seatsOff`. `delegating` = active slots except orchestrator, in `ROLE_ORDER`.

- [ ] **Step 1: Write the failing tests** in `tests/roster.test.ts`:
  - `seven slots in fixed order with nothing running`: `slots.map(s=>s.name)` equals `ROLE_ORDER`; every slot but orchestrator `idle`; `others` empty.
  - `active, idle with last ended, and off`: one running explorer job, a done oracle native ended at t, `disabledAgents:['librarian']` → explorer active, oracle idle with `lastEndedAt === t`, librarian off with `offReason 'disabledAgents'`.
  - `parallel instances stack`: two running fixer jobs with different sessionIds → one slot, two instances.
  - `jobs sharing a sessionId are one line with N rounds`: three jobs same sessionId → one instance, `rounds.length 3`, status of the latest.
  - `council is one slot`: seats alpha (codex) and beta (claude), `disabledAgents:['councillor:beta']` → council not off, `seatsOff ['beta']`; with `['council']` → off.
  - `delegating lists active roles in order`.
  - `other agents only when present`: a native with role `other` → `others.length 1`.
  - `ago formats`: `ago(12_000)==='12s'`, `ago(720_000)==='12m'`, `ago(3*3_600_000)==='3h'`.
- [ ] **Step 2: Run** `claude plugin test plugins/pantheon` — new tests FAIL.
- [ ] **Step 3: Implement** `hooks/roster.ts`.
- [ ] **Step 4: Run** tests — PASS.
- [ ] **Step 5: Commit**: `feat(pantheon): build the role roster from jobs, natives and config`

### Task 3: Port rail and elapsed

**Files:**
- Create: `plugins/pantheon/hooks/rail.tsx`, `plugins/pantheon/hooks/elapsed.tsx` (from `plugins/flightdeck/hooks/rail.tsx` and `elapsed.tsx`, add a one-line "Ported from scasella/claude-flightdeck 0.3.2 (MIT); see NOTICE." header)
- Test: `plugins/pantheon/tests/rail.test.ts`, `plugins/pantheon/tests/elapsed.test.ts`

**Interfaces:**
- `rail.tsx` default export `ClientModule<RailProps, { ref }>` with
  `RailProps = { active: boolean; width: number; color: string; dim: string; marks: number[]; isMerge: boolean; vertical?: boolean; glyph?: { on: string; off: string } }`.
  Changes vs flightdeck: `vertical` draws `│` cells top to bottom (height = `width`) with packets travelling downward; `glyph` when present renders a leading state glyph that alternates bold/normal every 600 ms while `active` (the pulse); color comes from the caller (engine color). Timers: one `surface.every(110)` for packets, one `surface.every(600)` for the pulse, both advancing only while `ref.active`.
- Also export pure helpers for tests: `export function railCells(width: number, phase: number, marks: number[], isMerge: boolean): { text: string; isLit: boolean }[]` and `export function pulseOn(tick: number): boolean`.
- `elapsed.tsx` unchanged in behavior; export `export function fmt(ms: number): string` for tests.

- [ ] **Step 1: Write the failing tests**: `railCells(24, 0, [], false)` has exactly one `●` and it is lit; `railCells(48, 5, [], false)` has two `●`; inactive (`phase` irrelevant) draws only `─`; marks render `┬`/`┴`; `pulseOn(0) !== pulseOn(1)`; `fmt(65_000)==='1:05'`, `fmt(3_660_000)==='1h01'`. Also mount each module through a fake surface object (`{ elements: { Box: (p)=>p, Text: (p)=>p }, state: undefined, setState, every, columns: 24 }`) and assert `every` is registered with 110 and 600 (rail) and 1000 (elapsed), and that the registered callbacks do not call `setState` when `active: false` / `endAt !== null`.
- [ ] **Step 2: Run** tests — FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** tests — PASS; `claude plugin validate plugins/pantheon` passes.
- [ ] **Step 5: Commit**: `feat(pantheon): port flightdeck's rail and elapsed surface modules`

### Task 4: Tracking hooks, state queues, auto-open and commands

**Files:**
- Modify: `plugins/pantheon/hooks/register.tsx`
- Test: `plugins/pantheon/tests/register.test.ts` (extend), `plugins/pantheon/tests/fixtures/world.ts` (add `ui.open` and `ui.copy` fakes recording into `seen.opened`)

**Interfaces:**
- Consumes: Task 1 reducers, `PANE_ID` from `pane.tsx`.
- Produces: atoms `nativesAtom = atom({ plugin: 'pantheon', key: 'natives' }, [])`, `sessionAtom` (`key: 'session'`, `DEFAULT_SESSION`), `viewAtom` (`key: 'view'`, `DEFAULT_VIEW`); a generic latest-snapshot queue `createQueue<T>(write: (v: T) => Promise<unknown>, onError: (e: unknown) => void)` returning `{ push(v: T): void; flushed(): Promise<void> }`, used for jobs (replacing `persist`), natives and session. In-memory `natives: Native[] | undefined` and `session: SessionInfo | undefined` loaded on first use with `normalizeNatives` + `markNativesLost` / `normalizeSession` (isRunning reset to false), like `ensureJobs`.
- Hooks (each wraps its tracking in `try/catch` and passes the event through):
  - `turn.start` (no `agentId` field exists): `sessionStarted`.
  - `turn.step` (streaming, `async function*`): `const result = yield* next(e)`; if `!e.agentId` → `sessionStepped(e.model, String(e.effort ?? ''))`; else `stepped({ id: e.agentId, turnId: e.turnId, now, usage: result.usage })`. Return `result`.
  - `turn.complete`: `const done = await next(e)`; no `agentId` → `sessionCompleted(e.durationMs)`; else `completed({ id, reason: e.reason, now })`. Return `done`.
  - `session.measure`: `sessionMeasured(e.context)`; return `next(e)`.
  - `agent.spawn`: `const started = await next(e)`; when `started.agentId` → `spawned({ id, type: e.subagentType, task: e.description, model: started.model, now })`. Return `started`.
  - `tool.call` (catch-all, no matcher; keep the existing matcher hooks): when `e.agentId` and the native is known → `toolNoted(id, describeTool(e.tool, e))`; return `next(e)`'s result.
  - `session.start`: after the current setup, `await $.ui.open({ id: PANE_ID, title: 'Pantheon', columns: 72, rows: 8 })`.
  - `command.run` `/pantheon`: no args → `$.ui.open` as today; `close` → `await $.ui.close({ id: PANE_ID })` and `{ text: 'Pantheon panel closed.' }`. Usage text lists `close`.
  - `ui.render` Pane: reads jobs, natives, session, view, config state and `$.clock.now()`, calls `buildRoster` and `drawPane` (Task 5 signature); `onTab(tab)` writes `viewAtom`.
- Status line, `statusText` and the jobs flow stay unchanged.

- [ ] **Step 1: Write the failing tests** in `register.test.ts`:
  - `every tracking hook returns the event result unchanged`: register a lower hook returning a sentinel for `turn.complete`, `agent.spawn`, `session.measure`, `tool.call`; assert the sentinel comes back through pantheon.
  - `agent.spawn of pantheon:oracle records a native`: after spawn + step + complete, `$.state` `pantheon.natives[0]` has `role 'oracle'`, `rounds[0].status 'done'`.
  - `queued writes land in order`: three quick steps → stored `steps === 3`.
  - `reload marks running native rounds lost`: seed state with a running round, start → status `lost`.
  - `the panel opens on session.start`: `seen.opened` contains `pantheon`.
  - `/pantheon close closes the panel`.
- [ ] **Step 2: Run** tests — FAIL.
- [ ] **Step 3: Implement** in `register.tsx` (keep the `Io` pattern; literal `$.noun.method` calls only in this file).
- [ ] **Step 4: Run** `claude plugin test plugins/pantheon` and `claude plugin validate plugins/pantheon` — PASS (the old `pane.test.ts` may fail until Task 5; if so, note it and leave it for Task 5).
- [ ] **Step 5: Commit**: `feat(pantheon): track native subagents and the main session for the panel`

### Task 5: Panel drawing (designer)

**Files:**
- Modify (rewrite): `plugins/pantheon/hooks/pane.tsx` (keep `PANE_ID`, `statusText`, `isResumable`, `configReport`, `doctorReport` and their behavior)
- Test: `plugins/pantheon/tests/pane.test.ts` (rewrite the drawing tests; keep the status-line test)

**Interfaces:**
- Consumes: `Roster`, `Slot`, `Instance`, `ago` (Task 2); `Job`; `rail.tsx`, `elapsed.tsx` (Task 3).
- Produces:
  ```ts
  export type PanelData = {
    surface: RenderSurface; placement?: string; columns: number; rows: number; now: number
    roster: Roster; jobs: Job[]; session: SessionInfo; tab: 'agents' | 'jobs'; hasClient: boolean
    onTab: (tab: 'agents' | 'jobs') => void
    onCancel: (jobId: string) => void
    onCopy: (text: string, surface: RenderSurface) => void
  }
  export function drawPanel(el: PanelElements, data: PanelData): unknown
  // PanelElements: Box, Text, Button, optional Client and Svg from $.ui.resolve(e)
  export function layoutOf(surface: RenderSurface, placement?: string): 'docked' | 'mini' | 'desktop'
  ```
- Layout: `placement === 'inline'` → mini; `surface !== 'terminal'` → desktop; else docked. Content per spec §3 and the round-1 artboards (Main, TerminalJobs, TerminalMini, Desktop, DesktopJobs). Motion per spec §4: rails and pulse via `<Client module="./rail.tsx">`, clocks via `<Client module="./elapsed.tsx">`, static fallbacks when `hasClient` is false; mini has no rails; desktop's "Last 15 minutes" card is one `Svg` (hex colors from the Desktop artboard). Terminal colors are theme names (Codex `suggestion`-family blue, Claude `merged`-family violet, running `success`, rounds `warning`, activity a cyan-ish theme color; pick from the types' theme color list). Header Buttons with keys `tab-agents`, `tab-jobs`; job Buttons `cancel-<id>`, `copy-<id>`. Copy text: `<jobId>\nresume: delegate({ agent: "<agent>", resume: "<jobId>", prompt: … })`.
- Fit: every Text uses `wrap="truncate"`; when rows are short, drop idle/off lines from the bottom before active ones.

- [ ] **Step 1: Write the failing tests** (mount through `$.ui.mount` as the current `pane.test.ts` does, after driving tracking events and delegate calls):
  - `agents tab shows seven slots in order (terminal, desktop)`: Texts for `orchestrator`, `explorer`, …, `council` appear in order.
  - `an active explorer shows its instance, activity and clock`.
  - `a resumed job shows round 2`: delegate, then delegate with `resume` → `↻ round 2` present.
  - `off role shows disabledAgents`.
  - `tab button switches to jobs`: press `tab-jobs` → `jobs` groups `active`/`finished`; `cancel-<id>` cancels a running job; `copy-<id>` copies text containing the job id.
  - `mini stays within 8 lines and collapses to +N` (`placement: 'inline'`, seven active roles faked through state → a `+1`).
  - `desktop draws the timeline Svg`.
  - `docked at 40 columns truncates` (no Text wider than 40 in the tree).
  - `other agents line only when present`.
- [ ] **Step 2: Run** tests — FAIL.
- [ ] **Step 3: Implement** `pane.tsx` and wire it in `register.tsx`'s `ui.render` (the only register change allowed in this task).
- [ ] **Step 4: Run** `claude plugin test plugins/pantheon` and `claude plugin validate plugins/pantheon` — PASS.
- [ ] **Step 5: Commit**: `feat(pantheon): draw the agents and jobs panel in terminal, mini and desktop`

### Task 6: Remove flightdeck, docs, NOTICE and version

**Files:**
- Delete: `plugins/flightdeck/`
- Modify: `.claude-plugin/marketplace.json`, `plugins/pantheon/.claude-plugin/plugin.json` (`0.3.0`), `plugins/pantheon/NOTICE`, `plugins/pantheon/README.md`, `README.md`, `AGENTS.md`, `docs/VERIFICATION.md`, `docs/PRIVACY.md`, `plugins/pantheon/docs/plan.md`, `plugins/pantheon/docs/design.md`, `Makefile` if it names flightdeck.

- [ ] **Step 1:** `grep -rn -i flightdeck --exclude-dir=.git .` lists every reference; remove or rewrite each outside `docs/superpowers/` and the two history docs.
- [ ] **Step 2:** NOTICE: add a section crediting `scasella/claude-flightdeck` 0.3.2 (MIT) with its full license text (copy from `plugins/flightdeck/LICENSE` before deleting), listing what was ported (rail, elapsed, subagent tracking, describe/redact) and how it was adapted (engine colors, vertical rails, pulse, rounds by turnId).
- [ ] **Step 3:** AGENTS.md: "six plugins"; drop the flightdeck bullet and its test command; rewrite the pantheon bullet to describe `tracking.ts`, `roster.ts`, `pane.tsx`, `rail.tsx`, `elapsed.tsx` and the `natives`/`session`/`view` state. README(s): the panel, auto-open, `/pantheon close`, and "flightdeck users: `/plugin uninstall flightdeck`". History docs: one dated note (2026-10-08) saying flightdeck was absorbed into the panel.
- [ ] **Step 4: Run** `make validate`, `node scripts/check-consistency.mjs`, `claude plugin test plugins/pantheon`, `git fetch origin && node scripts/check-version-bump.mjs origin/main` — all pass.
- [ ] **Step 5: Commit**: `feat(pantheon)!: absorb flightdeck into the Pantheon panel` (body: flightdeck removed from the marketplace).

### Task 7: Final verification (orchestrator)

- [ ] Whole-branch review by oracle against the spec.
- [ ] `claude --plugin-dir plugins/pantheon` real session in the terminal: run explorer (Codex, background) and oracle (native) in parallel; the panel shows both active with rails and clocks, then idle; record what was seen. The app check is listed as pending for the user if no app session is available here.
- [ ] PR, CI, squash merge, fast-forward, `make update`.
