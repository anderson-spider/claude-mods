# codex-team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin, `codex-team`, whose `execute` and `review` tools run Codex agents in Herdr panes as background jobs, with Claude as their lead.

**Architecture:** Same shape as `plugins/chatgpt`. `hooks/team.ts` is pure: names, arguments, prompt, the job lifecycle and the band rows, all against an injected `Herdr` interface. `hooks/herdr.ts` implements `Herdr` over the `herdr` CLI through `$.process.run`. `hooks/register.tsx` wires tools, commands, prompt section, toasts and the band. No helper process.

**Tech Stack:** TypeScript hooks module (Claude Code function hooks mod API), `claude-code/testing`, the `herdr` CLI (0.9.3) and `codex` CLI (0.160.1).

**Spec:** `docs/specs/2026-10-06-codex-lead-design.md`

## Global Constraints

- Plugin directory `plugins/codex-team/`; tools are `mcp__codex-team__execute`, `mcp__codex-team__review`, `mcp__codex-team__jobs`; commands `/codex-team` and `/codex-team-doctor`.
- Agent names `ct-<id>` (Herdr accepts `[a-z][a-z0-9_-]{0,31}`, unique among live agents); report files in `$TMPDIR/codex-team/<id>.md`.
- Codex arguments: `execute` is `-s workspace-write -a on-request`; `review` is `-s read-only -a on-request` (checked against `codex --help`, codex-cli 0.160.1). Never `--dangerously-bypass-approvals-and-sandbox`.
- Every herdr call goes through the injected `Herdr` and never rejects out of a job: an error becomes `failed` with its message. Panes are never closed by the plugin; `cancel` sends `ctrl+c` and leaves the pane.
- Split panes with `--no-focus`, `--cwd` the session's cwd, and an explicit target pane read from `HERDR_PANE_ID` (never rely on the focused pane).
- Job limit 30 minutes (constant `JOB_LIMIT_MS`); the failure is `failed` with "timeout"; the Codex is not killed.
- `$.process.run` kills a child after 30 s by default and at most 10 min: every herdr wait runs in chunks of at most `WAIT_CHUNK_MS` (540 000) and loops until the job deadline.
- Only `execute` is queued (one at a time); `review` is not.
- English everywhere (code, comments, tool text, band strings); the tests assert on the band strings. Band title `Codex Team`, rows `<agent> <kind>  <status>  <elapsed>  <pane>`, blocked row ends `← answer in the pane`, overflow `… and N more`.
- No `package.json`, build or lint; the typings come from Claude Code's load of the plugin (`plugins/*/.claude-plugin/types/`, git-ignored).
- Conventional Commits in English, no AI attribution lines. Bump `version` in `plugin.json` when behavior changes.

## Review Focus

Failure modes the spec implies that a person using the plugin is likely to hit:

1. A task or focus text with quotes, newlines, backticks or `$(…)`: it must reach `agent prompt` as one argv element, unchanged (tested in Task 4).
2. The person closes the Codex pane mid-job: the next herdr call fails; the job becomes `failed` naming the pane, never hangs (Task 2).
3. `cancel` on a job still queued (no pane yet), and on a finished job: queued becomes `cancelled` without touching herdr; finished answers "nothing to cancel" (Task 3).
4. `TMPDIR` unset: report path falls back to `/tmp/codex-team/<id>.md` (Task 1).
5. After a plugin reload the job counter restarts at 1 while `ct-1` may still be a live agent in an old pane: the new job must take the next free name, not fail on a name clash (Tasks 1 and 3).

---

### Task 1: Scaffold and pure helpers

**Files:**
- Create: `plugins/codex-team/.claude-plugin/plugin.json`, `plugins/codex-team/hooks/hooks.json`, `plugins/codex-team/tsconfig.json`, `plugins/codex-team/types/index.d.ts`, `plugins/codex-team/hooks/team.ts`, `plugins/codex-team/tests/codex-team.test.ts`
- Modify: `.claude-plugin/marketplace.json` (add the `codex-team` entry, alphabetical after `codex-computer-use`)

**Interfaces:**
- Produces (all exported from `hooks/team.ts`):
  - `type Kind = 'execute' | 'review'`
  - `agentName(id: number): string` → `ct-<id>`
  - `nextFreeId(from: number, live: readonly string[]): number` → smallest `id >= from` with `ct-<id>` not in `live`
  - `codexArgs(kind: Kind): string[]`
  - `splitDirection(size: { width: number; height: number }): 'right' | 'down'` → `right` when `width >= height * 2` (terminal cells are about twice as tall as wide), else `down`
  - `reportPath(tmpdir: string | undefined, id: number): string`
  - `buildPrompt(kind: Kind, input: { task?: string; files?: string[]; target?: string; focus?: string }, report: string): string`
  - `requestOf(kind: Kind, e: Record<string, unknown>): { kind: Kind; task: string; files: string[]; target?: string; focus?: string } | string` (a string is the error to answer)
- `types/index.d.ts` declares tool inputs in `McpToolInputs` (`mcp__codex-team__execute: { task: string; files?: string[] }`, `...review: { target?: string; focus?: string }`, `...jobs: { id?: number; action?: 'cancel' }`). The plugin state (`PluginState['codex-team']: { jobs: BandJob[] }`, `BandJob = { id: string; kind: Kind; status: Status; pane: string; elapsedSeconds: number }`, `Status` from Task 2) is added in Task 5. Mirror `plugins/chatgpt/types/index.d.ts` and `plugins/branch-guard/types/index.d.ts`; name `"types": "./types/index.d.ts"` in `plugin.json`.

- [ ] **Step 1: Write the failing tests** in `tests/codex-team.test.ts` (imports from `claude-code/testing` and `../hooks/team`):
  - `agentName(3)` is `ct-3`.
  - `nextFreeId(1, ['ct-1', 'ct-2', 'other'])` is `3`; `nextFreeId(1, [])` is `1`.
  - `codexArgs('execute')` equals `['-s', 'workspace-write', '-a', 'on-request']`; `codexArgs('review')` equals `['-s', 'read-only', '-a', 'on-request']`.
  - `splitDirection({ width: 286, height: 71 })` is `right`; `({ width: 80, height: 60 })` is `down`.
  - `reportPath('/var/tmp', 4)` is `/var/tmp/codex-team/4.md`; `reportPath(undefined, 4)` is `/tmp/codex-team/4.md`; a trailing slash in `tmpdir` does not double.
  - `buildPrompt('execute', { task: 'add X', files: ['a.ts'] }, '/tmp/codex-team/1.md')` contains the task, `a.ts`, the report path, and the rule "do not commit"; `buildPrompt('review', { target: 'main', focus: 'races' }, …)` contains the target and focus and tells Codex not to edit files; both tell Codex to write its final report to the report path and answer with only that path.
  - `requestOf('execute', {})` and `requestOf('execute', { task: '  ' })` return a string; `requestOf('execute', { task: ' t ', files: ['a', 3, ''] })` returns `{ kind: 'execute', task: 't', files: ['a'] }`; `requestOf('review', {})` is valid (review of the current diff).
- [ ] **Step 2: Run to verify failure.** Run `claude plugin test plugins/codex-team`. Expected: FAIL, `../hooks/team` has no such exports.
- [ ] **Step 3: Implement** the signatures above in `hooks/team.ts` and write the scaffold files. Add the marketplace entry with a one-sentence description in the style of the neighbors.
- [ ] **Step 4: Verify.** Run `claude plugin test plugins/codex-team` (Expected: PASS) and `claude plugin validate plugins/codex-team` and `claude plugin validate .` (Expected: both valid; `hooks.json` may name `./register.tsx` only once Task 5 creates it, so create a minimal `register.tsx` exporting `register: Register = () => {}` here).
- [ ] **Step 5: Commit** `feat(codex-team): scaffold the plugin and its pure helpers`

---

### Task 2: Job lifecycle

**Files:**
- Modify: `plugins/codex-team/hooks/team.ts`
- Test: `plugins/codex-team/tests/codex-team.test.ts`

**Interfaces:**
- Consumes: Task 1's `agentName`, `codexArgs`, `splitDirection`, `reportPath`, `buildPrompt`, `Kind`.
- Produces (exported from `hooks/team.ts`):
  - `type Status = 'queued' | 'starting' | 'working' | 'blocked' | 'done' | 'failed' | 'cancelled'`
  - `type Settled = 'idle' | 'done' | 'blocked'`
  - `class HerdrError extends Error { code: string }` (codes used: `agent_not_ready`, `agent_prompt_stalled`, `timeout`, any other string)
  - `type Herdr = { size(): Promise<{ width: number; height: number }>; split(direction: 'right' | 'down'): Promise<string>; start(name: string, pane: string, args: string[]): Promise<void>; prompt(name: string, text: string, timeoutMs: number): Promise<Settled>; wait(name: string, timeoutMs: number): Promise<Settled>; read(name: string, lines: number): Promise<string>; sendKeys(name: string, keys: string[]): Promise<void>; list(): Promise<{ name: string; pane: string }[]> }` (`prompt` and `wait` throw `HerdrError`; `timeout` means the given chunk ran out, not the job)
  - `type Job = { id: number; kind: Kind; title: string; status: Status; agent: string; pane?: string; startedAt: number; endedAt?: number; report?: string; summary?: string; error?: string }`
  - `type Files = { read(path: string): Promise<string | undefined> }`
  - `type Notify = (event: 'blocked' | 'finished', job: Job) => void`
  - `type Deps = { herdr: Herdr; files: Files; tmpdir: string | undefined; now: () => number; notify: Notify }`
  - `runJob(deps: Deps, job: Job, request: { kind: Kind; task: string; files: string[]; target?: string; focus?: string }, options?: { limitMs?: number; chunkMs?: number }): Promise<void>` (never rejects; mutates `job`; `JOB_LIMIT_MS` = 1 800 000 and `WAIT_CHUNK_MS` = 540 000 are the defaults, exported)

Lifecycle per the spec: set `starting`; `size` then `split`; `start` with `codexArgs(kind)`; if `start` throws `agent_not_ready`, set `blocked`, notify `blocked`, `wait` (chunked) until settled, then continue; set `working`; `prompt` (chunked: on `timeout` from a chunk, ask `wait` for the rest until the deadline); on `blocked` set `blocked`, notify once per blocked episode, `wait` again, and set `working` when it resumes; on `idle`/`done` read `files.read(reportPath(...))`; if present `report` is its path and `summary` its first 600 characters; if missing, `summary` is `herdr.read(agent, 200)` and the job notes "no report"; set `done`, `endedAt`, notify `finished`. Errors: `agent_prompt_stalled` and deadline overrun give `failed` with the message naming the pane (never resend the prompt); any other throw gives `failed` with `error` = the message plus the pane.

- [ ] **Step 1: Write the failing tests** with a scripted fake `Herdr` (an array of calls recorded; `prompt`/`wait` pop scripted outcomes: a `Settled` value or a `HerdrError`) and a fake `Files` map:
  - happy path execute: calls are `size`, `split('right')`, `start('ct-1', 'w1:p2', ['-s','workspace-write','-a','on-request'])`, `prompt`; job ends `done` with `report` path and `summary`; `notify` got `finished` once.
  - review uses `-s read-only`.
  - prompt settles `blocked`, then `wait` settles `idle`: statuses observed in order `starting, working, blocked, working, done`; `notify('blocked')` exactly once.
  - `start` throws `agent_not_ready`: job `blocked`, then waits and proceeds to `prompt`.
  - report file missing: `done`, `summary` is the pane text, `error` mentions "no report".
  - `agent_prompt_stalled`: job `failed`, `error` contains the pane id, no second `prompt` call.
  - a chunk `timeout` followed by `idle` finishes `done`; with `limitMs` 0 and a `timeout`, the job is `failed` and `error` contains "timeout" (use a fake `now`).
  - **Review Focus 2:** `wait` throws a generic `HerdrError('pane not found')` mid-job: job `failed`, `error` contains `w1:p2`, `runJob` resolves.
- [ ] **Step 2: Run to verify failure.** `claude plugin test plugins/codex-team`. Expected: FAIL, `runJob` not defined.
- [ ] **Step 3: Implement** the types and `runJob` in `hooks/team.ts`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(codex-team): add the job lifecycle against an injected Herdr`

---

### Task 3: Job book, queue, cancel and reports

**Files:**
- Modify: `plugins/codex-team/hooks/team.ts`
- Test: `plugins/codex-team/tests/codex-team.test.ts`

**Interfaces:**
- Consumes: Task 2's `Job`, `Deps`, `runJob`, `Herdr`; Task 1's `nextFreeId`, `agentName`, `requestOf` result type.
- Produces (exported from `hooks/team.ts`):
  - `createBook(deps: Deps): { start(request: Request): Promise<Job>; cancel(id: number): Promise<string>; jobs(): readonly Job[]; get(id: number): Job | undefined; orphans(): Promise<{ name: string; pane: string }[]> }` where `Request` is `requestOf`'s success type. `start` allocates the id with `nextFreeId(counter, (await herdr.list()).map(a => a.name))`, creates the job `queued` and returns it at once; `execute` jobs run through a one-at-a-time queue (reuse the `taskQueue` shape from `plugins/chatgpt/hooks/chatgpt.ts`, copied since plugins do not share code), `review` jobs start immediately; `list()` failure falls back to the plain counter.
  - `jobsReport(jobs: readonly Job[], now: number): string` (newest first, one line per job: `ct-<id> <kind> <status> (<minutes>): <title 60 chars>`, then an indented line with `report <path>` or the error)
  - `jobDetail(job: Job): string` (status, pane, report path, summary or error)
- `cancel(id)` returns a sentence: unknown id; "nothing to cancel" for `done`/`failed`/`cancelled`; for `queued`, mark `cancelled` without calling herdr (the queued run must then skip); for `starting`/`working`/`blocked`, `sendKeys(agent, ['ctrl+c'])`, mark `cancelled`, leave the pane.

- [ ] **Step 1: Write the failing tests** (fake `Herdr` from Task 2):
  - two `execute` starts: the second job is `queued` until the first finishes, then runs; a `review` started meanwhile runs at once.
  - **Review Focus 5:** `list()` returns `ct-1` and `ct-2` live: the first job gets id 3 and agent `ct-3`.
  - **Review Focus 3:** cancel of a queued job: `cancelled`, the fake `Herdr` saw no call for it, and when the queue reaches it nothing runs; cancel of a working job sends `['ctrl+c']` to its agent and never closes anything; cancel of a done job returns a "nothing to cancel" sentence; unknown id returns an error sentence.
  - `jobsReport` newest first and contains the report path; empty list gives `No Codex Team jobs in this session.`
- [ ] **Step 2: Run to verify failure.** Expected: FAIL, `createBook` not defined.
- [ ] **Step 3: Implement** `createBook`, `jobsReport`, `jobDetail`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(codex-team): queue execute jobs and add cancel and the jobs report`

---

### Task 4: Herdr adapter over the CLI

**Files:**
- Create: `plugins/codex-team/hooks/herdr.ts`
- Test: `plugins/codex-team/tests/codex-team.test.ts`

**Interfaces:**
- Consumes: `Herdr`, `HerdrError`, `Settled` from `./team`.
- Produces: `herdrOf(run: Run, options: { pane: string; cwd: string }): Herdr` where `type Run = (argv: string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>` (register passes `$.process.run`); also `herdrAvailable(run: Run, env: { HERDR_ENV?: string }): Promise<string | undefined>` returning the reason when unusable (not inside Herdr, `herdr` or `codex` missing), else `undefined`.
- Mapping (every command starts with `herdr`; output is JSON, errors are JSON on stderr with exit status 1 and an `error.code` — read it into `HerdrError.code`; when stderr is not JSON the code is `unknown`):
  - `size`: `pane layout --pane <pane>` → `.result.layout.area.{width,height}`
  - `split(dir)`: `pane split <pane> --direction <dir> --cwd <cwd> --no-focus` → `.result.pane.pane_id`
  - `start`: `agent start <name> --kind codex --pane <pane> -- <args>`
  - `prompt(name, text, timeoutMs)`: `agent prompt <name> <text> --wait --timeout <timeoutMs>`; the process `timeoutMs` is the chunk plus 20 000; returns the settled status read from the JSON (`agent_status`, else a follow-up `agent get`)
  - `wait`: `agent wait <name> --timeout <timeoutMs>`
  - `read`: `agent read <name> --source recent-unwrapped --lines <n>` → text
  - `sendKeys`: `agent send-keys <name> <keys…>`
  - `list`: `agent list` → `.result.agents[]` filtered to names starting `ct-`, mapped to `{ name, pane: pane_id }`. The `agent list` entries carry no `name` field in the sample output; the implementer must run `herdr agent list --help`/`herdr agent get` once against a named agent started by hand (`herdr agent rename`) and use the real key before relying on this.

- [ ] **Step 1: Write the failing tests** with a fake `Run` that records argv and answers canned JSON:
  - **Review Focus 1:** `prompt('ct-1', 'a "b"\n`c` $(d)', 1000)` passes the text as exactly one argv element equal to the input.
  - `split('right')` argv is `['herdr','pane','split','w1:p1','--direction','right','--cwd','/proj','--no-focus']` and returns the pane id from the canned JSON.
  - a failing command with stderr `{"error":{"code":"agent_not_ready"}}` throws `HerdrError` with that code; non-JSON stderr gives code `unknown`.
  - `herdrAvailable` returns a reason mentioning Herdr when `HERDR_ENV` is not `1`, and one naming `codex` when `codex --version` fails.
- [ ] **Step 2: Run to verify failure.** Expected: FAIL, `../hooks/herdr` missing.
- [ ] **Step 3: Implement** `herdr.ts`. Verify each JSON path against the real CLI by running the read-only commands (`pane layout`, `agent list`, `agent get`) and keep only paths seen in real output.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(codex-team): drive Herdr through its CLI`

---

### Task 5: Host wiring, band, commands and prompt

**Files:**
- Modify: `plugins/codex-team/hooks/team.ts` (band rows, prompt section text), `plugins/codex-team/hooks/register.tsx`, `plugins/codex-team/types/index.d.ts`
- Test: `plugins/codex-team/tests/codex-team.test.ts`

**Interfaces:**
- Consumes: `createBook`, `herdrOf`, `herdrAvailable`, `jobsReport`, `jobDetail`, `requestOf`.
- Produces in `hooks/team.ts`: `bandRows(jobs: readonly BandJob[], room: number): { rows: string[]; hidden: number }` (a row is `<agent> <kind>  <status>  <m>m<ss>s  <pane>`, plus `  ← answer in the pane` when `blocked`; at most `room` rows; `hidden` counts the rest, the band prints `… and N more`), and `PROMPT: string` (section `codex-team`: delegate well-bounded work to `execute`, call `review` before integrating, read the job's report not the pane, do not start a second `execute` while one is queued in the same directory, say in one line before delegating, load the tools first if deferred).
- `register.tsx` follows `plugins/chatgpt/hooks/register.tsx` and `plugins/branch-guard/hooks/register.tsx`:
  - `session.start`: clear `$.state`, register tools `execute`, `review`, `jobs` (descriptions and `inputSchema` matching `types/index.d.ts`) and commands `codex-team`, `codex-team-doctor`.
  - `tool.call` for each tool: outside Herdr (`HERDR_ENV` not `1`) answer `{ result, isError: true as const }` with the reason; `execute`/`review` call `requestOf`, then `book.start`, and answer "Started job ct-<id>. A message arrives when it finishes; jobs lists it meanwhile."; `jobs` with no id returns `jobsReport`, with an id `jobDetail`, with `action: 'cancel'` the `cancel` sentence.
  - `Notify`: `blocked` raises `$.ui.toast('Codex Team: ct-<id> needs you in <pane>')` only; `finished` raises a toast and `$.prompt.submit({ text })` with `[codex-team job ct-<id> <status>: <kind>]`, the summary and the report path, `.catch(() => undefined)`.
  - State: the book's jobs are the truth; after every status change write a `BandJob[]` snapshot of the non-finished jobs to `$.state` (`codex-team`/`jobs`).
  - `ui.render` on `{ component: 'AbovePrompt' }`: a bordered `Box` titled `Codex Team`, rows from `bandRows(…, e.props.maxRows - CHROME_ROWS)`, `… and N more`; `CHROME_ROWS` = border (2) + title (1) + overflow line (1) = 4; nothing drawn when no job is active or `e.props.hasSurvey`.
  - `prompt.compose` adds `{ id: 'codex-team:lead', text: PROMPT, scope: 'session' }`.
  - `command.run` `codex-team`: `jobsReport` plus orphan `ct-*` agents from `book.orphans()` that are not in `jobs()`; `codex-team-doctor`: one `✓`/`✗` line per check (`HERDR_ENV=1`, `herdr --version`, `codex --version`, `herdr agent list` answers).
  - The `Herdr`, `Files` and `Deps` for the book come from `$`: `$.process.run`, `$.fs.read` (read the exact name in the generated `claude-code/index.d.ts`), `$.env.get('TMPDIR')`, `$.env.get('HERDR_PANE_ID')`, `$.session.cwd()`, `Date.now`.

- [ ] **Step 1: Write the failing tests** for the pure parts: `bandRows` with three jobs and `room` 2 gives two rows and `hidden` 1; a `blocked` row ends with `← answer in the pane`; elapsed formats as `2m10s`; no jobs gives no rows; `PROMPT` mentions `execute`, `review` and the report.
- [ ] **Step 2: Run to verify failure.** Expected: FAIL, `bandRows` not defined.
- [ ] **Step 3: Implement** `bandRows`, `PROMPT` and `register.tsx` per the bullets.
- [ ] **Step 4: Verify.** `claude plugin test plugins/codex-team` (PASS), `claude plugin validate plugins/codex-team` (valid), and, once the plugin has loaded once so the typings exist, `tsc -p plugins/codex-team` (no errors).
- [ ] **Step 5: Commit** `feat(codex-team): wire tools, band, commands and prompt section`

---

### Task 6: Live check and docs

**Files:**
- Modify: `AGENTS.md` (plugin count and list in the intro, a `## codex-team` section in the style of the others, the `claude plugin test plugins/codex-team` line under Commands), `README.md` (an entry in the plugin list), `plugins/codex-team/.claude-plugin/plugin.json` (`version` `0.1.0`)

**Interfaces:**
- Consumes: the finished plugin.
- Produces: the docs and a verified run.

- [ ] **Step 1: Live smoke test** from a Claude Code session started in a Herdr pane with `claude --plugin-dir plugins/codex-team` in a scratch git repository (not this one): call `/codex-team-doctor` (Expected: all `✓`); call `review` on a small diff (Expected: a pane `ct-1` opens beside, band shows `working`, a toast and a new turn arrive with a report path that exists); call `execute` with a one-line task (Expected: the file changes in the scratch repo, no commit made). Then `cancel` a long `execute` (Expected: `ctrl+c` seen in the pane, job `cancelled`, pane still open). Record the observed output in the commit body or the PR description.
- [ ] **Step 2: Fix anything the live run shows** (selectors for the real JSON, agent state names, flag spellings), adding a regression test for each in `tests/codex-team.test.ts`.
- [ ] **Step 3: Write the docs** in `AGENTS.md` (structure: the three files, `Herdr` injection, queue and chunked waits, the report file, why panes stay open, how `blocked` reaches the person) and `README.md`.
- [ ] **Step 4: Verify everything.** Run `claude plugin test plugins/codex-team`, `claude plugin validate plugins/codex-team` and `claude plugin validate .`. Expected: all pass.
- [ ] **Step 5: Commit** `docs(codex-team): document the plugin` (the live-run notes in the body).

---

## Self-review

- **Spec coverage:** tools (Tasks 1, 3, 5); lifecycle steps 1-7 (Tasks 2, 3); state, band, commands, prompt section and toasts (Task 5); each error line of the spec (Task 2 tests, Task 4 `herdrAvailable`, Task 5 outside-Herdr answer); tests list (Tasks 1-5); housekeeping (Tasks 1 and 6).
- **Decisions the spec left open:** `agent_not_ready` keeps the job `blocked` and then continues once the agent settles; waits run in chunks because `$.process.run` caps at 10 minutes; the counter skips live `ct-*` names after a reload; `TMPDIR` falls back to `/tmp`; the split target is explicit (`HERDR_PANE_ID`); `JOB_LIMIT_MS` is a constant, not a setting.
- **Known unknown:** the real key for an agent's name in `herdr agent list` JSON is not in the sampled output; Task 4 Step 3 resolves it against the real CLI before relying on it.
