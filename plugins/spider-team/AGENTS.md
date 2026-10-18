# spider-team

Usage: [README.md](README.md).

- Skills only: no `hooks/`, no `tsconfig.json`, so `claude plugin test` and `tsc` skip it; `claude plugin validate --strict plugins/spider-team` is its check.
- `skills/spider-team/SKILL.md`: the run Main owns (seven phases, each ending on its exit), the tier table, the brief format and the `progress` calls. User-invoked only (`disable-model-invocation: true`).
- `agents/spider-{fable,opus,sonnet,haiku}.md`: one body per tier, frontmatter `model` only. The default effort travels in each Agent call, so subagent-effort's Jev can replace it.
- Contracts with spider-progress, which `plugins/spider-progress/hooks/tiers.ts` and `hooks/state.ts` read:
  - Agents are called namespaced, `spider-team:spider-<tier>`; the bare name does not resolve for a plugin agent.
  - A brief's first line is `spider-task: T<n>`; it binds the worker to its task.
  - Task ids are `T` plus up to three digits; owners are `main`, `explore`, `fable`, `opus`, `sonnet` or `haiku`.
  - Changing a tier, its model or its default effort means changing `TIERS` in `plugins/spider-progress/hooks/tiers.ts` too.
- Without spider-progress the skill skips reporting; `/live-test` is the only proof of the skill's behaviour.
