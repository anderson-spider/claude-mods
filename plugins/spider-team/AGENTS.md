# spider-team

Usage: [README.md](README.md).

- Skills only: no `hooks/`, no `tsconfig.json`, so `claude plugin test` and `tsc` skip it; `claude plugin validate --strict plugins/spider-team` is its check.
- `skills/spider-team/SKILL.md`: the run Main owns and implements (seven phases, each ending on its exit; Main writes the code by default, delegates implementation only to parallel workers on disjoint files, at most `max_workers` at once, calls the planner, researcher or reviewer by value and risk, never as a fixed step, reviews every delegated diff and verifies the integrated result; only Main runs Git writes), the modes its arguments pick (`<task>`, `on`, `off`, `brainstorm <topic>`), session mode, the role table, the Design rule, the task contract (`spider-task`, Goal, Scope, Interfaces, Done when, Deliver) and the `progress` calls. User-invoked only (`disable-model-invocation: true`).
- `skills/spider-team/new-project.md`: the greenfield steps (spec, plan, `AGENTS.md`, `filemap.md`, approval before delegating), loaded only when the request is to build a new project and the working directory is empty.
- Session mode keeps one spider-progress run open across messages: appending is a replan with the whole list, and a different `title` would start a new run, so Main sends the title only at `on`.
- `agents/spider-{planner,worker,researcher,reviewer}.md`: frontmatter `model` as a full ID (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`), so a provider without it fails loudly rather than resolving an alias to an older model; the skill passes no `model`, since the call's `model` would override it. Tools enforce what they can: planner and reviewer `Read, Grep, Glob` (no edit, shell or agent), researcher adds `WebSearch, WebFetch, Write, Edit` (no shell), worker `disallowedTools: Agent`; each lists `ToolSearch` and `mcp__spider-progress__step`. Scope, Git-write and docs-path limits are prompt rules only: tool lists cannot scope `Bash` or `Write`, and plugin agents ignore `permissionMode` and `hooks`.
- `userConfig` in `plugin.json`: `max_workers` and one effort per role, substituted into SKILL.md as `${user_config.KEY}`. An unset option stays a literal placeholder in Claude Code 2.1.301 (its `default` is not substituted), so the skill names the fallback beside each one; never repeat the placeholder token in that fallback text, or it is substituted too. The effort travels in each Agent call, so subagent-effort's Jev can replace it; the agents set no `effort`.
- Contracts with spider-progress, which `plugins/spider-progress/hooks/tiers.ts` and `hooks/state.ts` read:
  - Agents are called namespaced, `spider-team:spider-<role>`; the bare name does not resolve for a plugin agent.
  - A brief's first line is `spider-task: T<n>`; it binds the worker to its task.
  - Task ids are `T` plus up to three digits; owners are `main`, `planner`, `worker`, `researcher` or `reviewer`.
  - Changing a role, its model or its default effort means changing `TIERS` in `plugins/spider-progress/hooks/tiers.ts` too.
- Without spider-progress the skill skips reporting; a real session that loads the plugin is the only proof of the skill's behaviour.
