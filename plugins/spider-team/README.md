# spider-team

`/spider-team <task>` makes the session the owner of a task: it understands it, plans tasks with dependencies, investigates, delegates what earns it to four tiered agents, reviews every result against the real diff, verifies and delivers. Workers only claim they are done; a task counts once the session has reviewed it.

```text
/plugin install spider-team --marketplace anderson-spider/claude-mods
```

## Use

```text
/spider-team add rate limiting to the public API
```

The run goes through Understand, Plan, Investigate, Execute, Review, Verify and Complete. Small or tightly coupled work stays with the session; read-only questions run in parallel; writers never touch the same files at once.

| Agent | Model | Default effort | For |
| --- | --- | --- | --- |
| `spider-fable` | Fable | high | the hardest logic and bugs |
| `spider-opus` | Opus | high (xhigh for unfamiliar code) | delicate or hard changes |
| `spider-sonnet` | Sonnet | high | standard feature work |
| `spider-haiku` | Haiku | high | mechanical edits, builds, tests |

`spider-fable` needs access to the Fable model. With [subagent-effort](../subagent-effort/README.md) installed, Jev's rating replaces the default effort of each call.

With [spider-progress](../spider-progress/README.md) installed, the run shows as a band under the session card and in the `/spider-agents` pane. Without it, the skill runs the same and reports nothing.

## Privacy

The skill and agents are prompts: they send nothing anywhere themselves. Briefs go to the subagents the session starts, as any delegation does.

## Tests

The plugin ships prompts only, so there are no automated tests; `claude plugin validate --strict` checks its files, and behaviour is checked in a live session. See [AGENTS.md](AGENTS.md).

## Acknowledgements

The design is inspired by `savvy-flow` from [claude-kit](https://github.com/JohnnyVizz/claude-kit) by johnnyvizz (MIT). The prompts here are our own.
