# codex-team

A Codex team in Herdr, led by the Claude Code session: a developer, an analyst and an architect run as named Codex agents in a team tab, started when first needed and reused after. The session hands them tasks, reads their short reports and reviews their diffs; the work runs on the Codex quota.

```text
/plugin install codex-team --marketplace anderson-spider/claude-mods
```

Requires [Herdr](https://herdr.dev) (the session must run in a Herdr pane) and the Codex CLI, signed in.

## Use

Type `/codex-team:using-codex-team`. Outside Herdr it says it cannot be used and stops; inside, the session becomes the team's tech lead until it ends: it splits each request into tasks, hands each one to a role, waits for the agents in the background and reviews what comes back.

`mcp__codex-team__dispatch` `{ role, task, slug, cwd?, effort? }` hands one task to one agent:

| Role | Agent | Works in | Starts with |
| --- | --- | --- | --- |
| `developer` | `dev-<slug>` | the task worktree (`cwd`, never the repository itself) | `gpt-6.1-sol`, effort `high`; may write the worktree, the repository's git directory and the reports |
| `analyst` | `analyst` | the reports directory; reads the repository | `gpt-6-luna`, effort `medium`; writes only reports |
| `architect` | `architect` | the reports directory; reads the repository | `gpt-6.1-sol`, effort `high`; writes only reports |

Every agent runs Codex's `workspace-write` sandbox with the network on and no approval prompts (`-a never`). `effort` overrides the role's default.

- **Team tab:** the first agent opens a tab labelled `codex team` in the current workspace; later agents split beside a live team agent. Focus never moves.
- **Reuse:** a live agent with the role's name gets the next task; a busy or blocked one gets nothing.
- **One writer per worktree:** a second developer in a directory another developer works in is refused.
- **Delivery:** `confirmed` (the agent was seen working), `not_sent` (it never reached the agent) or `unknown` (it may have): an `unknown` prompt is never sent again.
- **Reports:** each brief asks the agent to end by writing `~/.claude/codex-team/reports/<repository>/<slug>-<role>.md` with fixed fields (`status`, `summary`, `files`, `commits`, `checks`, `blockers`, `questions`, `drafts`).

## Privacy

The task text goes to the Codex agent in Herdr, as typed. The plugin writes one record per dispatch to `~/.claude/codex-team/decisions/`: role, agent, model, effort and where it came from, a hash of the task, the delivery status and a Herdr error code. Never the task text, a path or output.

## Credits

The delivery states, the never-resend rule and the Codex start flags follow [herdr-router](https://github.com/Qingswe/herdr-router), used with its author's permission.

## Tests

Logic tests drive `hooks/herdr.ts` and `hooks/team.ts` with a scripted `herdr`/`git` runner (`tests/fake-run.ts`); host tests run the plugin against a fake host (`tests/host.ts`). Nothing starts Herdr or Codex. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
