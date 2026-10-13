# codex-team

A Codex team in Herdr, led by the Claude Code session: a developer, an analyst and an architect run as named Codex agents in a team tab, started when first needed and reused after. The session hands them tasks, reads their short reports, reviews their diffs and does the git work; the work itself runs on the Codex quota.

```text
/plugin install codex-team --marketplace anderson-spider/claude-mods
```

Requires [Herdr](https://herdr.dev) (the session must run in a Herdr pane) and the Codex CLI, signed in.

## Use

Type `/codex-team:using-codex-team`. Outside Herdr it says it cannot be used and stops; inside, the session becomes the team's tech lead until it ends: it splits each request into tasks, hands each one to a role, waits for the agents in the background and reviews what comes back.

`mcp__codex-team__dispatch` `{ role, task, slug, cwd?, effort? }` hands one task to one agent:

| Role | Agent | Works in | Starts with |
| --- | --- | --- | --- |
| `developer` | `dev-<slug>` | the task worktree (`cwd`, never the repository itself) | `gpt-6.1-sol`, default effort `high`, Fast (`priority`); may write the worktree and the reports, and leaves changes uncommitted |
| `analyst` | `analyst` | the reports directory; reads the repository | `gpt-6-luna`, default effort `medium`, Fast (`priority`); writes only reports |
| `architect` | `architect` | the reports directory; reads the repository | `gpt-6.1-sol`, default effort `high`, Fast (`priority`); writes only reports |

Fast is Codex's `priority` service tier, set at startup with `-c service_tier="priority"` for `gpt-6-luna` and `gpt-6.1-sol`. Any model id containing `astra` is explicitly excluded; other models outside the allowlist keep their default service tier. Astra also never starts above effort `high`: higher pinned, Jev or default choices are capped at `high`, the answer explains the cap, and the decision records the capped effort. The current role table does not use Astra.

Every agent runs Codex's `workspace-write` sandbox with the network on and no approval prompts (`-a never`). The sandbox keeps `.git` read-only, so the team never commits: the session reviews the uncommitted diff and commits, pushes and opens the pull request through the [git-master](../git-master/README.md) subagent (Haiku).

Set `JEV_API_KEY` in your environment to enable Jev (TypeSafe, pinned to `jev-1.13.0`). Each dispatch asks about difficulty (five levels), duration (four) and scope (four), then selects the lowest-penalty effort: `medium`, `high` or `xhigh` for the developer and architect, and `low`, `medium` or `high` for the analyst. The policy follows herdr-router's asymmetric distribution scoring, with cheaper effort breaking ties. The answer's role line shows the chosen effort and its source (`jev`, `default` or `pinned`). An explicit `effort` wins and skips Jev entirely.

Without a valid key, or if Jev fails, the role's default from the table is used and a fixed reason code is logged. A key declared in the project's `.claude/settings.json` or `settings.local.json` `env` block is refused (`repo-declared-key`), even if it matches your key; unreadable settings disable Jev too. Calls share a three-second deadline including one retry of transient failures, a breaker after three service failures and a four-call concurrency cap.

The chosen effort applies only when this dispatch starts the agent (`effortApplied: true` in its record). An agent is never restarted to change effort. Reusing a live agent keeps its start effort, records `effortApplied: false` and adds `not applied: reused agent keeps its start effort` to the answer's role line, after the chosen effort and source.

- **Team tab:** the first agent opens a tab labelled `codex team` in the current workspace; later agents split beside a live team agent. Focus never moves.
- **Reuse:** a live agent with the role's name gets the next task; a busy or blocked one gets nothing. The answer still discloses that the chosen effort was not applied to that existing agent.
- **One writer per worktree:** a second developer in a directory another developer works in is refused.
- **Delivery:** `confirmed` (the agent was seen working), `not_sent` (it never reached the agent) or `unknown` (it may have): an `unknown` prompt is never sent again.
- **Reports:** each brief asks the agent to end by writing `~/.claude/codex-team/reports/<repository>/<slug>-<role>.md` with fixed fields (`status`, `summary`, `files`, `checks`, `blockers`, `questions`, `drafts`).

## Privacy

The task text goes to the Codex agent in Herdr, as typed. With `JEV_API_KEY` set and accepted, the redacted task text, cut to at most 4000 characters, is sent to `api.typesafe.ai` for effort assessment. Secrets, emails and absolute paths are redacted (repository paths become relative). Named secret values are consumed completely, including long values, escaped quotes and values cut off at the end, before the task is capped. Flag-attached absolute paths and UNC paths are recognized without a home or repository context. Relative flag arguments remain intact; UNC recognition requires a host and share, so quoted escapes such as `"\\n"` are preserved, while an unfinished quoted UNC path is still masked. Redaction uses patterns and cannot guarantee removal of every sensitive detail; keep sensitive task content out of dispatches that use Jev. No repository files, report contents or conversation context are sent to Jev. The key is used only in the request's `Authorization` header.

The plugin writes one version-2 record per dispatch to `~/.claude/codex-team/decisions/`: role, agent, model, effort and its source, whether it was applied (`effortApplied`), pinned Jev model id, expected levels per dimension rounded to one decimal (or null), a fixed Jev fallback reason (or null), a hash of the task, the delivery status and a Herdr error code. Records, answers and plugin logs never include the key or task text; records never include a path or response body.

## Credits

The delivery states, the never-resend rule, the Codex start flags and the effort assessment/scoring follow [herdr-router](https://github.com/Qingswe/herdr-router), used with its author's permission. Jev's client and redaction are copied from the [crew](../crew/README.md) plugin, with no cross-plugin runtime imports.

## Tests

Logic tests drive the pure modules with fake fetch, timers and a scripted `herdr`/`git` runner (`tests/fake-run.ts`); host tests run the plugin against a fake host (`tests/host.ts`). No network request is made and nothing starts Herdr or Codex. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
