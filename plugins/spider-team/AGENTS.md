# spider-team

Usage: [README.md](README.md).

- Skills only: no `hooks/`, no `tsconfig.json`, so `claude plugin test` and `tsc` skip it; `claude plugin validate --strict plugins/spider-team` is its check.
- `skills/spider-team/SKILL.md`: the run Main owns (seven phases, each ending on its exit), the modes its arguments pick (`<task>`, `on`, `off`, `brainstorm <topic>`), session mode, the tier table, the Design rule, the brief format and the `progress` calls. User-invoked only (`disable-model-invocation: true`).
- `skills/spider-team/new-project.md`: the greenfield steps (spec, plan, `AGENTS.md`, `filemap.md`, approval before delegating), loaded only when the request is to build a new project and the working directory is empty.
- Session mode keeps one spider-progress run open across messages: appending is a replan with the whole list, and a different `title` would start a new run, so Main sends the title only at `on`.
- `agents/spider-{fable,opus,sonnet,haiku}.md`: a shared body plus one rule of the tier's own (Fable reproduces a bug before fixing it, Opus lists invariants and reports how it checked them, Sonnet follows local conventions and writes the tests the brief names, Haiku stays mechanical and quotes failures), frontmatter `model` only. The default effort travels in each Agent call, so subagent-effort's Jev can replace it.
- Contracts with spider-progress, which `plugins/spider-progress/hooks/tiers.ts` and `hooks/state.ts` read:
  - Agents are called namespaced, `spider-team:spider-<tier>`; the bare name does not resolve for a plugin agent.
  - A brief's first line is `spider-task: T<n>`; it binds the worker to its task.
  - Task ids are `T` plus up to three digits; owners are `main`, `explore`, `fable`, `opus`, `sonnet` or `haiku`.
  - Changing a tier, its model or its default effort means changing `TIERS` in `plugins/spider-progress/hooks/tiers.ts` too.
- Without spider-progress the skill skips reporting; `/live-test` is the only proof of the skill's behaviour.
