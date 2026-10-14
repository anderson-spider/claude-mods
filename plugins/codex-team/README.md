# codex-team

A Codex team in Herdr, led by the Claude Code session: a developer, an analyst and an architect run as workspace-specific Codex agents in tabs labelled `codex - <slug>`, started when first needed. Shared analyst and architect sessions are one-shot; named task agents are reused for followups. A reviewer checks the developer’s uncommitted work against the original task. The session hands them tasks, reads their short reports, reviews their diffs and does the git work; the work itself runs on the Codex quota.

```text
/plugin install codex-team --marketplace anderson-spider/claude-mods
```

Requires [Herdr](https://herdr.dev) (the session must run in a Herdr pane) and the Codex CLI, signed in.

## Use

Type `/codex-team:using-codex-team`. Outside Herdr it says it cannot be used and stops; inside, the session becomes the team's tech lead until it ends: it splits each request into tasks, hands each one to a role, waits for the agents in the background and reviews what comes back.

`mcp__codex-team__dispatch` `{ role, slug, task?, cwd?, effort? }` hands one task to one agent. `slug` is required, starts with a lowercase letter, contains only lowercase letters, digits and hyphens, and has at most 22 characters; longer slugs are refused without truncation. `task` is required for developer, analyst and architect; for reviewer it is optional extra focus:

| Role | Agent | Works in | Starts with |
| --- | --- | --- | --- |
| `developer` | `dev-<slug>` | the task worktree (`cwd`, never the repository itself) | `gpt-6.1-sol`, default effort `high`, Fast (`priority`); may write the worktree and the reports, and leaves changes uncommitted |
| `analyst` | `analyst`, or `analyst-<slug>` when the shared analyst is working or blocked | the reports directory; reads the repository | `gpt-6-luna`, default effort `medium`, Fast (`priority`); writes only reports |
| `architect` | `architect` | the reports directory; reads the repository | `gpt-6.1-sol`, default effort `high`, Fast (`priority`); writes only reports |
| `reviewer` | `architect-<slug>` | the reports directory; reads the recorded developer worktree | architect model, fixed effort `xhigh` (Astra caps to `high`), Fast (`priority`); writes only the reviewer report |

Fast is Codex's `priority` service tier, set at startup with `-c service_tier="priority"` for every model, including Luna, Sol and Astra. Astra never starts above effort `high`: higher pinned, Jev or default choices are capped at `high`, the answer explains the cap, and the decision records the capped effort. The current role table does not use Astra.

Every agent runs Codex's `workspace-write` sandbox with the network on and no approval prompts (`-a never`). The sandbox keeps `.git` read-only, so the team never commits: the session reviews the uncommitted diff and commits, pushes and opens the pull request through the [git-master](../git-master/README.md) subagent (Haiku).

Set `JEV_API_KEY` in your environment to enable Jev (TypeSafe, pinned to `jev-1.13.0`). Each unpinned developer, analyst or architect dispatch asks about difficulty (five levels), duration (four) and scope (four), then selects the lowest-penalty effort: `medium`, `high` or `xhigh` for the developer and architect, and `low`, `medium` or `high` for the analyst. The policy follows herdr-router's asymmetric distribution scoring, with cheaper effort breaking ties. The answer's role line shows the chosen effort and its source (`jev`, `default` or `pinned`). An explicit `effort` wins and skips Jev entirely for those roles. Reviewer skips Jev and settings, always selecting `xhigh` with source `review-policy`, subject to the existing Astra cap.

Without a valid key, or if Jev fails, the role's default from the table is used and a fixed reason code is logged. A key declared in the project's `.claude/settings.json` or `settings.local.json` `env` block is refused (`repo-declared-key`), even if it matches your key; unreadable settings disable Jev too. Calls share a three-second deadline including one retry of transient failures, a breaker after three service failures and a four-call concurrency cap.

The chosen effort applies only when this dispatch starts the agent (`effortApplied: true` in its record). Shared analyst and architect sessions are finished before their next dispatch, which starts a fresh session with the new effort. Named task agents remain reusable; reusing one keeps its start effort, records `effortApplied: false` and adds `not applied: reused agent keeps its start effort` to the answer's role line, after the chosen effort and source.

- **Names:** the table uses logical names, which `finish` and plan owners accept. Herdr sees a role letter (`n` for analyst, `a` for architect, `d` for developer), a stable workspace token, and `-<slug>` for named task agents. The token is a lossless, case-sensitive base-62 to base-36 encoding of `HERDR_WORKSPACE_ID` with a leading sentinel: `w6F` and `w6f` stay distinct, including leading zeroes. For example, in `w1`, `analyst` is `n1r` and `dev-fix` is `d1r-fix`. All effective names fit 32 characters with a full 22-character slug. Unsupported IDs or tokens longer than eight characters are refused before effects; there is no hashing or truncation. Dispatch returns both names; type the effective name from its `Herdr:` line in CLI `wait`, `get` and `read` commands, and the logical name in `finish`.
- **Task tabs:** `dev-<slug>`, `architect-<slug>` and `analyst-<slug>` share `codex - <slug>`. Without a live agent for that slug in this workspace the plugin creates a tab; otherwise it splits beside that task’s live agent pane. Each shared `analyst` or `architect` starts in a fresh tab with the same exact `codex - <slug>` format, using the current dispatch slug as the main task. A dedicated tab keeps the current task visible and preserves the one-shot lifecycle without storing or updating a label. Creation and splits use `--no-focus`; tabs close with their last pane.
- **Reuse:** an idle or done shared `analyst` or `architect` in the dispatch workspace is finished and archived before a fresh session starts. A failed finish refuses the dispatch. Named task agents get followups in their existing session. Busy/reuse, reviewer/developer, cwd, writer and pane checks are workspace-local; another workspace's logical names do not block dispatch. A real collision where this workspace's effective name is owned elsewhere fails closed, including an `agent start` refusal. For analyst, a busy or blocked local shared agent selects `analyst-<slug>` automatically; no flag is needed. Existing sessions retain their startup effort. Legacy unnamespaced agents are not adopted or closed by the new namespace.
- **Dispatch queue:** one in-module promise queue serializes every dispatch and finish, including context reads, listings, closure, archive, tab creation, startup and prompt. Failed deliveries remove only their own newly created context; a failure releases the queue for the next call.
- **One writer per worktree:** a second developer in a directory another developer works in is refused.
- **Delivery:** `confirmed` (the agent was seen working), `not_sent` (it never reached the agent) or `unknown` (it may have): an `unknown` prompt is never sent again.
- **Reports:** each brief asks the agent to end by writing `~/.claude/codex-team/reports/<repository>/<workspace-token>/<slug>-<role>.md` using the same case-sensitive workspace token as effective Herdr names. Replies and briefs carry the actual path; equal repository roots and slugs in different workspaces have separate report files. Reviewer reads the developer report in its own workspace token directory. Reports use fixed fields (`status`, `summary`, `files`, `checks`, `blockers`, `questions`, `drafts`). Reviewer uses `<slug>-reviewer.md` with `verdict: accept|changes_needed`, `risk: low|high`, `findings:` lines `- <severity> <file>:<line> <failure scenario> -> <fix>`, and `checks:`.
- **Review:** after `herdr agent wait <effective-name>` from the developer dispatch reply, dispatch `{ role: "reviewer", slug: "<slug>" }`. The plugin supplies the original task, developer worktree and report path and asks for `git status --short`, both unstaged and staged diffs, every untracked file and applicable AGENTS.md rules. An undispatched slug or a developer currently working or blocked is refused as `not_sent`. Delivery rechecks the developer on its own listing before creating a pane, starting an agent or sending the review prompt. The reviewer runs with the same report-only sandbox as the architect.
- **Closing:** `mcp__codex-team__finish` `{ agent: "dev-<slug>" }` finishes one idle or done team agent in the dispatch workspace. It resolves the logical name to this workspace’s effective Herdr name. It accepts only `analyst`, `architect`, `analyst-<slug>`, `architect-<slug>` and `dev-<slug>`. It reads the Codex thread UUID from `herdr agent get`, refuses working/blocked agents, foreign workspaces, the lead pane and uncertain ownership, then closes only that agent’s pane. Herdr removes `codex - <slug>` when its last pane closes; sibling panes remain. A short bounded poll waits for the agent to disappear from `herdr agent list` before `codex archive <uuid>`. The answer reports the closed pane/tab and archive outcome; archive failures retain only an exit code or fixed reason. The lead finishes named agents when their task closes. Worktrees are retained.

## Plan and Dagr

The newest regular `.crew/plans/*.md` file under the session root is the active plan, selected by modification time. Only its `## Steps` section defines tasks; `## Dispatches` and other sections are ignored. Each `### <title>` heading containing steps becomes a deliverable project (`T1`, `T2`, …), in order. The lead writes steps as:

```markdown
## Steps

### Feature

- build-feature (dev-feature, after: —) Implement the feature — state: implementing

### Review and release

- review-feature (architect-feature, after: build-feature) Inspect the diff — state: queued
- ship-feature (git-master, after: review-feature) Commit and publish — state: queued
```

IDs use kebab-case. Owners are `main`, `dev-<slug>`, `analyst`, `analyst-<slug>`, `architect`, `architect-<slug>` or `git-master`. Dependencies are comma-separated IDs or `—` for none; every dependency is retained, including cross-deliverable edges. Unknown dependencies, duplicates, cycles, owners or states are validation errors. Fenced code examples are ignored; only the opening marker with at least its length and no trailing text closes a fence.

States are `queued`, `implementing`, `verified`, `blocked`, `committed` and `skipped`; a parenthesized note may follow the state. Developer maps to `impl`, architect/reviewer to `review`, analyst to `docs`, and main/git-master to `ship`. Blocked remains blocked and its note names the unblocker (the owner when no note was supplied). Verified and committed become done with **reported** evidence and the plan note as receipt; they do not establish mechanical verification. Queued/skipped/blocked have no attempt; implementing with a locator and done have one attempt. `.dagr/times.json` keeps first observation times by plan id, step id and state, so unrelated plans sharing a step id keep independent observations. These are not measured execution durations.

After a dispatch delivery attempt and after a successful Write/Edit under `.crew/plans/`, the plugin writes `.dagr/run.json.tmp`, checks it with `dagr check <tmp> --strict --json`, and moves it over `.dagr/run.json` only for exit 0 with the complete JSON array `[]`. Publications are serialized per root. A failure keeps the old run and logs one line; the tool result and dispatch delivery stay intact. Validator discovery tries `DAGR_BIN`, then `dagr` on PATH, then the first usable `$HOME/.config/herdr/plugins/github/herdr-dagr-*/bin/dagr` match, without a fixed installation hash. Paths with spaces are passed as one argument. If none is available, publishing stops and logs one line once per module load. Keep `.dagr/` out of version control in the repository using the plugin.

The lead’s `main` and `git-master` steps use the orchestrator pane from `HERDR_PANE_ID`; Codex workers use their own pane from `herdr agent list`, filtered to this workspace and mapped back from effective names to logical plan owners. An implementing step without its required pane is published as blocked with no attempt and an unblocker naming the owner whose live pane must be restored. Its dependencies and plan note are preserved. The plan does not supply prompt acknowledgement or output timestamps.

## Privacy

The task text goes to the Codex agent in Herdr, as typed. With `JEV_API_KEY` set and accepted, the redacted task text, cut to at most 4000 characters, is sent to `api.typesafe.ai` for effort assessment. Secrets, emails and absolute paths are redacted (repository paths become relative). Named secret values are consumed completely, including long values, escaped quotes and values cut off at the end, before the task is capped. Flag-attached absolute paths and UNC paths are recognized without a home or repository context. Relative flag arguments remain intact; UNC recognition requires a host and share, so quoted escapes such as `"\\n"` are preserved, while an unfinished quoted UNC path is still masked. Redaction uses patterns and cannot guarantee removal of every sensitive detail; keep sensitive task content out of dispatches that use Jev. No repository files, report contents or conversation context are sent to Jev. The key is used only in the request's `Authorization` header.

The plugin writes one version-2 record per dispatch to `~/.claude/codex-team/decisions/`: role, logical agent and effective Herdr name, model, effort and its source, whether it was applied (`effortApplied`), pinned Jev model id, expected levels per dimension rounded to one decimal (or null), a fixed Jev fallback reason (or null), a hash of the task, the delivery status and a Herdr error code. Decision filenames use the effective name to separate equal logical names and timestamps across workspaces. A separate small plugin-store record, keyed by workspace, session root and slug, keeps the developer’s cwd and original task for reviewer briefs across reloads. Followups retain that original task; changing worktree requires a new slug. A refused first delivery does not leave a reviewer record. This record contains the task as supplied and is distinct from the decision log. Each explicit or automatic finish writes a separate version-2 record with action `finish`, logical agent and effective Herdr name, Codex UUID, `closed`, `archived` and a fixed reason or exit code, never the task. Records in the decision log, answers and plugin logs never include the key or task text; records never include a path or response body.

## Credits

The delivery states, the never-resend rule, the Codex start flags and the effort assessment/scoring follow [herdr-router](https://github.com/Qingswe/herdr-router), used with its author's permission. Jev's client and redaction are copied from the former crew plugin, with no cross-plugin runtime imports.

## Tests

Logic tests drive the pure modules with fake fetch, timers and a scripted `herdr`/`git`/`codex` runner (`tests/fake-run.ts`); host tests run the plugin against a fake host (`tests/host.ts`). No network request is made and nothing starts Herdr or Codex. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
