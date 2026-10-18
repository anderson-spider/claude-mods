# spider-team

`/spider-team <task>` makes the session the owner of a task: it understands it, plans tasks with dependencies, investigates, delegates every code change to four tiered agents, reviews every result against the real diff, verifies and delivers. Workers only claim they are done; a task counts once the session has reviewed it.

```text
/plugin install spider-team --marketplace anderson-spider/claude-mods
```

## Use

```text
/spider-team add rate limiting to the public API
```

The run goes through Understand, Plan, Investigate, Execute, Review, Verify and Complete. The session never writes code itself: every change goes to a tier and comes back through review. Read-only questions run in parallel; writers never touch the same files at once.

Asked to build a new project from an empty directory, the run starts it: it writes `docs/SPEC.md`, `docs/PLAN.md`, a short `AGENTS.md` and `filemap.md`, and delegates nothing until you approve the spec and the plan. Visual decisions stay with the session, which shows new screens as mockups first and reviews what was built itself; product questions the request leaves open go to you.

To stop retyping the command, turn on session mode:

| Command | What it does |
| --- | --- |
| `/spider-team on` | Every later message that asks for a change becomes tasks appended to one list, executed in order; questions are answered without a task, and an unclear message gets a one-line question. Messages sent while it works join the list. Verify runs each time the list drains. |
| `/spider-team brainstorm <topic>` | Plans the topic into a backlog and waits: refine it in the conversation, then say go. In session mode the backlog joins the list. |
| `/spider-team off` | Finishes or cancels the open tasks as you say, verifies and closes the run. |

| Agent | Model | Default effort | For |
| --- | --- | --- | --- |
| `spider-fable` | Fable | high | the hardest logic and bugs |
| `spider-opus` | Opus | high (xhigh for unfamiliar code or an unclear root cause) | delicate or hard changes |
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
