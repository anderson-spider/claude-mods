# git-master

Registers `git-master:git-master`, a Haiku subagent for git work: status, diffs, branches, worktrees, commits, rebase, conflicts, push, and pull or merge requests (`gh`, `glab`). Its description asks the session to call it whenever a request is about git, so the session hands git work off instead of spending its own model on it.

```text
/plugin install git-master --marketplace anderson-spider/claude-mods
```

## Use

Nothing to configure. Ask for git work ("commit this", "open the PR", "rebase on main") and the session delegates it; or name it: "use git-master to ...". It follows the git rules in the session's instructions (`CLAUDE.md`, `AGENTS.md`) and the request; without a project convention it writes Conventional Commits in English. It rewrites history only where the request allows, with `--force-with-lease`, never names an AI tool as an author, and stops before discarding work the request does not cover.

Tools: `Bash`, `Read`, `Grep`, `Glob`, and `Edit` for conflict fixes. No `Write` and no `Agent`: it never delegates.

## Privacy

The plugin registers an agent definition and nothing else: it reads and sends nothing. The subagent runs on Haiku like any Claude Code subagent.

## Tests

Host tests run the plugin against a fake host (`tests/host.ts`). For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
