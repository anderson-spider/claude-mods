# codex-team

A Codex team in Herdr, led by the Claude Code session: a developer, an analyst and an architect run as workspace-specific Codex agents in tabs labelled `codex - <slug>`, started when first needed. Every dispatch starts a fresh Codex session, including developer followups and reviewer dispatches. Settled predecessors are safely closed and archived first; the worktree and its uncommitted changes persist. A reviewer checks the developer’s uncommitted work against the original task. The session hands them tasks, reads their short reports, reviews their diffs and does the git work; the work itself runs on the Codex quota.

```text
/plugin install codex-team --marketplace anderson-spider/claude-mods
```

Requires [Herdr](https://herdr.dev) (the session must run in a Herdr pane) and the Codex CLI, signed in.

## Use

Type `/codex-team:using-codex-team`. Outside Herdr it says it cannot be used and stops; inside, the session becomes the team's tech lead until it ends: it splits each request into tasks, hands each one to a role, waits for the agents in the background and reviews what comes back.

`mcp__codex-team__dispatch` `{ role, slug, task?, cwd?, model?, effort? }` hands one task to one agent. `slug` is required, starts with a lowercase letter, contains only lowercase letters, digits and hyphens, and has at most 22 characters; longer slugs are refused without truncation. `task` is required for developer, analyst and architect; for reviewer it is optional extra focus:

| Role | Agent | Works in | Fallback pair and permissions |
| --- | --- | --- | --- |
| `developer` | `dev-<slug>` | the task worktree (`cwd`, never the repository itself) | `gpt-6.1-sol`, default effort `high`, Fast (`priority`); may write the worktree and the reports, and leaves changes uncommitted |
| `analyst` | `analyst`, or `analyst-<slug>` when the shared analyst is working or blocked | the reports directory; reads the repository | `gpt-6-luna`, default effort `medium`, Fast (`priority`); writes only reports |
| `architect` | `architect` | the reports directory; reads the repository | `gpt-6.1-sol`, default effort `high`, Fast (`priority`); writes only reports |
| `reviewer` | `architect-<slug>` | the reports directory; reads the recorded developer worktree | `gpt-6.1-sol`, default effort `high`, Fast (`priority`); writes only the reviewer report |

Fast is Codex's `priority` service tier, set at startup with `-c service_tier="priority"` for every model, including Luna, Sol and Astra. Astra never starts above effort `high`: higher pinned or default choices are capped at `high`, the answer explains the cap, and the decision records the capped effort. The current role table does not use Astra.

Every agent runs Codex's `workspace-write` sandbox with the network on and no approval prompts (`-a never`). The sandbox keeps `.git` read-only, so the team never commits: the session reviews the uncommitted diff and commits, pushes and opens the pull request through the [git-master](../git-master/README.md) subagent (Haiku).

Set `JEV_API_KEY` in your environment to enable Jev (TypeSafe, pinned to `jev-1.13.0`). The lead keeps the role; Jev chooses only a model and effort profile for every new session, including reviewer. Role instructions, sandbox and write permission remain fixed by `SPECS`. Selection happens after the delivery guards and previous-agent retirement, before creating a pane. Refusals never ask Jev or read its settings. Eligible followups of every role select a fresh profile. For reviewer, the assessed task text is the generated review brief: the recorded developer task, worktree/report references and optional cleaned review focus. The reviewer role default is `gpt-6.1-sol`/`high`; it applies on assessment/access failure or as the omitted field of a structured pin. The Astra cap still applies to any selected pair.

All four roles use one table. Points and affinities are policy priors, not model benchmarks. Rank is an ordinal tie breaker, not measured cost or latency:

| Profile | Model | Effort | Difficulty | Duration | Scope | Rank | Task type affinity |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `sol-medium` | `gpt-6.1-sol` | medium | 2.57 | 0.9 | 1 | 4 | 1; research/docs 0.9 |
| `sol-high` | `gpt-6.1-sol` | high | 2.86 | 1.5 | 2 | 5 | 1; research/docs 0.9 |
| `sol-xhigh` | `gpt-6.1-sol` | xhigh | 3 | 2.2 | 3 | 6 | 1; research/docs 0.9 |
| `luna-low` | `gpt-6-luna` | low | 0 | 0.3 | 0.5 | 1 | 0.8; research/docs 1 |
| `luna-medium` | `gpt-6-luna` | medium | 0 | 0.9 | 0.5 | 2 | 0.8; research/docs 1 |
| `luna-high` | `gpt-6-luna` | high | 0.43 | 1.5 | 0.5 | 3 | 0.8; research/docs 1 |

One logical assessment asks four questions: difficulty (0–4), duration (0–3), scope of code to inspect or change (0–3), and primary `task_type` (`implement`, `bugfix`, `refactor`, `review`, `research`, `docs`, `test`). Choice uses a criteria map. Probabilities must be finite, in [0,1], and have positive mass; omitted entries become zero and distributions are normalized. A missing task_type answer uses a uniform prior; a present malformed choice or missing score fails the assessment. Extra response dimensions and metadata are discarded.

The score penalty for each dimension is `weight × sum(P(t) × (4 max(0, t-point-0.5) + 0.5 max(0, point-t-0.5)))`, with weights 1/1/0.5. Choice adds `0.25 × sum(P(option) × (1-affinity(option)))`, looking up the exact option, then `*`, then 1. Each weighted dimension and the total round to four decimal places. Lowest penalty wins, then rank, then table order. There is no additional cost or time penalty.

Pins are optional:

- Structured `model` (`gpt-6.1-sol` or `gpt-6-luna`) or `effort` (`low`, `medium`, `high`, `xhigh`) skips Jev and settings entirely. The omitted field comes from the role default. Explicit pairs outside the automatic table remain valid and have no profile id.
- An inline `@sol-high` (or any profile id above) fixes both fields; structured pins may accompany it only if they agree.
- `!hard`, `!long`, `!quick` mean `!difficulty=3`, `!duration=3`, `!duration=0`. General forms are `!difficulty=<0..4>`, `!duration=<0..3>`, `!scope=<0..3>`, `!task_type=<option>`. Each dimension pin replaces its distribution with unit mass; only remaining questions go to Jev. With all dimensions pinned, scoring is local (`override`), without a key, settings or HTTP.
- Explicit pairs take precedence over dimension pins; the record marks the dimensions unused. Every role, including reviewer, applies pins to its fresh startup pair, including followups. A reviewer focus containing only directives remains valid because the recorded task supplies the review brief.

Directives are complete whitespace-delimited tokens outside inline code, matching code fences and quoted strings. Escape literal mentions with `\@` or `\!`, or put them in code/quotes. Unknown `@` ids, invalid values, contradictory pins and unknown dimensions are refused with a fixed error that never echoes the token. Equal duplicates are allowed. Recognized directives are removed without rebuilding the remaining task; an empty brief is refused. For example, `Inspect the cache !hard !scope=2` asks only duration and task_type; `Update the docs @luna-low` starts that explicit profile.

Without a valid key, or on any Jev/access failure, the exact role default model and effort pair from the role table is used, subject to the cap. Dimension pins are then marked unused; there is no keyword fallback. A key declared in the project's `.claude/settings.json` or `settings.local.json` env block is refused (`repo-declared-key`), even if it matches your key; unreadable settings disable Jev too. Calls retain a three-second deadline, one retry of transient failures, a breaker after three service failures and a four-call concurrency cap.

The answer shows the selected pair and source only when a selection was made for a new session. `modelApplied` and `effortApplied` are both true only if the agent actually started. A failed start discloses that the pair was not applied. Every eligible dispatch retires its previous idle/done agent and selects a fresh startup pair. Working or blocked targets are refused; failed close/archive or a reappearing name also prevents a replacement. Dispatch duration includes this lazy assessment.

- **Names:** the table uses logical names, which `finish` and plan owners accept. Herdr sees a role letter (`n` for analyst, `a` for architect, `d` for developer), a stable workspace token, and `-<slug>` for named task agents. The token is a lossless, case-sensitive base-62 to base-36 encoding of `HERDR_WORKSPACE_ID` with a leading sentinel: `w6F` and `w6f` stay distinct, including leading zeroes. For example, in `w1`, `analyst` is `n1r` and `dev-fix` is `d1r-fix`. All effective names fit 32 characters with a full 22-character slug. Unsupported IDs or tokens longer than eight characters are refused before effects; there is no hashing or truncation. Dispatch returns both names; type the effective name from its `Herdr:` line in CLI `wait`, `get` and `read` commands, and the logical name in `finish`.
- **Task tabs:** `dev-<slug>`, `architect-<slug>` and `analyst-<slug>` share `codex - <slug>`. Without a live agent for that slug in this workspace the plugin creates a tab; otherwise it splits beside that task’s live agent pane. Each shared `analyst` or `architect` starts in a fresh tab with the same exact `codex - <slug>` format, using the current dispatch slug as the main task. A dedicated tab keeps the current task visible and preserves the one-shot lifecycle without storing or updating a label. Creation and splits use `--no-focus`; tabs close with their last pane.
- **Session lifecycle:** every idle/done predecessor in the dispatch workspace is safely closed and archived before a fresh session starts, including `dev-<slug>`, `architect-<slug>` and `analyst-<slug>`. Busy or blocked targets are refused. Unknown state, foreign ownership or failed retirement refuses the dispatch too; no existing session receives another prompt. The existing busy/blocked shared analyst fallback still selects `analyst-<slug>`, whose predecessor follows the same retirement policy. Name resolution and all writer/reviewer guards run before retirement, then a fresh listing rechecks those guards before selection and startup. Busy, reviewer/developer, cwd, writer and pane checks are workspace-local; other workspaces' logical names do not block dispatch. A real effective-name collision or an agent-start refusal fails closed. Legacy unnamespaced agents are not adopted or closed.
- **Developer followups:** keep the same slug and worktree, including its uncommitted diff. Every brief must be self-contained because the new session has no conversational memory. When that slug was dispatched before, the plugin adds a fixed reminder to read the previous developer report and inspect the worktree git diff before continuing. The original task/cwd stored for reviewer briefs remains unchanged.
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

After a dispatch delivery attempt, finish, or a successful Write/Edit under `.crew/plans/`, the plugin publishes the active plan. After every Bash result, in the main session or a subagent, it compares the active plan's path, modification time and size with its last successful publication. Shell edits made with sed, Python, heredocs or git therefore refresh the pane too, even when the command reports an error after changing the file. An unchanged plan needs one directory listing, with no plan read or publication; a missing directory is skipped after an existence check. Commands are not parsed. Restoring both a file's modification time and size can hide an edit from this metadata check.

The plugin writes `.dagr/run.json.tmp`, checks it with `dagr check <tmp> --strict --json`, and moves it over `.dagr/run.json` only for exit 0 with the complete JSON array `[]`. Publications and fingerprint checks are serialized per root. Only a successful publication updates the fingerprint, so a failure can be retried. A failure keeps the old run and logs one debug line; Bash and Write/Edit results and dispatch delivery stay intact. Validator discovery tries `DAGR_BIN`, then `dagr` on PATH, then the first usable `$HOME/.config/herdr/plugins/github/herdr-dagr-*/bin/dagr` match, without a fixed installation hash. Paths with spaces are passed as one argument. If none is available, publishing stops and logs one line once per module load. Keep `.dagr/` out of version control in the repository using the plugin.

The lead’s `main` and `git-master` steps use the orchestrator pane from `HERDR_PANE_ID`; Codex workers use their own pane from `herdr agent list`, filtered to this workspace and mapped back from effective names to logical plan owners. An implementing step without its required pane is published as blocked with no attempt and an unblocker naming the owner whose live pane must be restored. Its dependencies and plan note are preserved. The plan does not supply prompt acknowledgement or output timestamps.

## Privacy

The task text goes to the Codex agent in Herdr with recognized directives removed. With `JEV_API_KEY` set and accepted, the redacted task text, cut to at most 4000 characters, is sent to `api.typesafe.ai` for profile assessment. Secrets, emails and absolute paths are redacted (repository paths become relative). Named secret values are consumed completely, including long values, escaped quotes and values cut off at the end, before the task is capped. Flag-attached absolute paths and UNC paths are recognized without a home or repository context. Relative flag arguments remain intact; UNC recognition requires a host and share, so quoted escapes such as `"\\n"` are preserved, while an unfinished quoted UNC path is still masked. Redaction uses patterns and cannot guarantee removal of every sensitive detail; keep sensitive task content out of dispatches that use Jev. No repository files, report contents or conversation context are sent to Jev. The key is used only in the request's `Authorization` header.

The plugin writes a version-3 decision record per dispatch to `~/.claude/codex-team/decisions/`. Its `selection` is `{model, effort, profileId, source, penalty}` only when a new startup selection was made, otherwise null. Records include logical and effective agent identities, `modelApplied`/`effortApplied`, whether HTTP was asked (`jevAsked`), the locally pinned Jev id when asked, expected scores rounded to one decimal, normalized task_type probabilities and uniform-prior flag, validated pins and their usage, unused dimensions, fixed fallback reason, the cleaned task hash and delivery metadata. They never contain task text, raw directives, paths, keys or response bodies; there is no startup configuration store. A separate small plugin-store record keyed by workspace, root and slug retains the developer's cwd and cleaned original task for reviewer briefs. Followups preserve it; another worktree requires another slug. A refused first delivery leaves no reviewer context. Decision filenames use the effective name to separate equal logical names and timestamps across workspaces. Each finish still writes its separate version-2 record with action, logical and effective agent names, Codex UUID, closed/archived and a fixed reason.

## Credits

The existing delivery states, never-resend rule and Codex start flags follow [herdr-router](https://github.com/Qingswe/herdr-router). Profile scoring is implemented from the supplied mathematical policy description.

## Tests

Logic tests drive the pure modules with fake fetch, timers and a scripted `herdr`/`git`/`codex` runner (`tests/fake-run.ts`); host tests run the plugin against a fake host (`tests/host.ts`). No network request is made and nothing starts Herdr or Codex. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
