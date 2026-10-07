# codex-team: Claude as lead of Codex agents in Herdr

Date: 2026-10-06
Status: design, awaiting review

## Goal

Let Claude act as a lead that delegates work to Codex agents. Two tools,
`execute` (implement a task) and `review` (review a diff), each run a Codex in
its own Herdr pane. The person can watch the pane, type into it and answer its
approval prompts. Claude does not wait: every call returns a job id and the
result arrives later as a new turn.

## Decisions

| Topic | Decision |
|---|---|
| Where `execute` works | The current directory, no worktree. One `execute` at a time (queue). |
| Waiting | Always background: the tool returns a job id at once. |
| Approvals | Sandboxed Codex; a `blocked` job warns the person, who answers in the pane. Claude never answers. |
| Backend | A plugin over the Herdr CLI (`$.process.run`), no helper, no LaunchAgent. |
| Pane after a job | Left open. The plugin never closes a pane, tab, workspace or session. |

Out of scope for now: per-job worktree isolation, Claude answering approvals,
a socket helper, jobs surviving a reload.

## Shape

New plugin `plugins/codex-team/`, following the `chatgpt`
plugin:

- `hooks/team.ts`: pure logic (prompt, agent name, Codex arguments, split
  direction, report reading). Everything that touches the host goes through an
  injected `Herdr` (`split`, `start`, `prompt`, `wait`, `read`, `sendKeys`,
  `list`), so tests use a fake host.
- `hooks/register.tsx`: host wiring (tools, jobs, toast, band, commands,
  prompt section).
- `types/index.d.ts`: tool inputs and the plugin state (`PluginState`, key
  `codex-team`/`jobs`).
- `tests/codex-team.test.ts`, `.claude-plugin/plugin.json`, an entry in
  `.claude-plugin/marketplace.json`, a section in `AGENTS.md` and the README.

## Tools

Registered with `$.tool.register` in `session.start`, listed as
`mcp__codex-team__<name>`:

- `execute { task, files? }`: Codex implements the task in the current
  directory, sandbox `workspace-write`. Queued: one at a time.
- `review { target?, focus? }`: Codex reviews the current diff, or the target
  (branch, commit), sandbox `read-only`. Runs in parallel, one pane each.
- `jobs { id?, action? }`: lists jobs, reads one job's result, or cancels
  (`action: cancel`).

`execute` and `review` return a job id immediately.

## Job lifecycle

States: `queued → starting → working ⇄ blocked → done | failed | cancelled`.

Each job is a detached `void (async () => …)()`, the same shape as the
`chatgpt` plugin's `startJob`:

1. **Queue.** `execute` waits its turn in a `taskQueue`; `review` skips it.
2. **Pane.** `herdr pane split --current --direction <right|down> --cwd "$PWD"
   --no-focus`; the direction follows `herdr pane layout` (wide pane: right,
   narrow or tall: down). The pane id is `.result.pane.pane_id`.
3. **Agent.** `herdr agent start ct-<id> --kind codex --pane <pane> -- <args>`,
   where `<args>` set the sandbox (`-s workspace-write` or `-s read-only`) and
   `-a on-request` (flags checked against `codex --help`, codex-cli 0.160.1).
   The call returns once Codex is ready.
4. **Prompt.** `herdr agent prompt ct-<id> "<prompt>" --wait`. The prompt holds
   the task, the rules (do not commit, stay inside the scope) and the order to
   write the final report to `$TMPDIR/codex-team/<id>.md` and answer only with
   that path.
5. **Wait.** `agent wait` in a loop: `working` keeps the job running;
   `blocked` sets the job to `blocked` and raises a toast ("Codex needs you");
   `idle` or `done` ends the wait.
6. **Result.** Read `<id>.md`. If it is missing, fall back to `agent read
   --source recent-unwrapped` and mark the result "no report". The job becomes
   `done`; a toast announces it and `$.prompt.submit` hands Claude a turn with
   the summary and the report path.
7. **Cleanup.** The pane stays open and the job keeps the agent name. `cancel`
   sends `ctrl+c`, marks the job `cancelled` and leaves the pane.

Jobs live in a module variable (lost on a reload). The panes survive, so
`/codex-team` also lists orphan `ct-*` agents from `herdr agent list`.

## State and UI

- The module's job list is the source of truth. `$.state` holds only what the
  band draws: per job `id`, kind, status, pane, elapsed seconds.
  `session.start` clears state left by a reload.
- Band in `AbovePrompt`, one row per active job, no buttons (the decision is in
  the pane):

  ```
  Codex Team
    ct-3 execute  working   2m10s   w34:p2
    ct-4 review   blocked   0m45s   w34:p3  ← answer in the pane
  ```

  `blocked` is highlighted; finished jobs leave the band after the toast; the
  rows are capped at `maxRows - CHROME_ROWS` with `… and N more`.
  `CHROME_ROWS` follows the band's fixed rows (border, title, footer). The band's
  strings are English and the tests assert on them.
- Commands: `/codex-team` (jobs and orphan panes) and `/codex-team-doctor`
  (`HERDR_ENV=1`, `herdr` and `codex` in PATH and their versions, whether
  `agent start --kind codex` works).
- A `prompt.compose` section `codex-team` teaches Claude to lead: delegate
  well-bounded work to `execute`, call `review` before integrating, read the
  job's report instead of the pane, and not start a second `execute` while one
  is queued in the same directory. The tools may be deferred, so their
  descriptions alone are not seen until loaded.
- Toasts: `done`, `failed` and `blocked` raise `$.ui.toast`; `done` and
  `failed` also call `$.prompt.submit`; `blocked` only warns the person.

## Errors

Every host call goes through the injected `Herdr` and never rejects; an error
becomes a result.

- Outside Herdr (`HERDR_ENV` not 1): the tools answer `isError` with the
  reason and try nothing.
- `herdr` or `codex` missing: the job is `failed` with the message;
  `/codex-team-doctor` names the missing one.
- `agent_not_ready` at start: the job is `blocked`.
- `agent_prompt_stalled` or `timeout`: the prompt may have arrived, so it is not
  resent; the job is `failed` and names the pane to inspect.
- Missing report: `done` with "no report" and the text read from the pane.
- Per-job limit (30 minutes, like the `chatgpt` `BACKGROUND_MS`): `failed
  (timeout)`; the Codex is not killed.

## Tests

`tests/codex-team.test.ts`, run with `claude plugin test plugins/codex-team`,
using a fake `Herdr` that answers by subcommand:

- `team.ts`: prompt building, sandbox arguments per kind, `ct-<id>` name, split
  direction, report reading.
- Lifecycle: `queued → working → done`, `blocked` and back, `failed` for each
  error above, `cancelled`.
- Queue: two `execute` jobs run in sequence; `review` does not wait.
- UI: band strings, `… and N more`, no band without jobs.
- The prompt section is present and the tool inputs match
  `types/index.d.ts`.

## Housekeeping

Add `plugins/codex-team` to `marketplace.json`, a `codex-team` section to
`AGENTS.md` (and update its plugin count and list), a README entry, and
`version` in `plugin.json`. Pull request title and description in English.
