# spider-team

`/spider-team <task>` makes the session the owner and main implementer of a task: it understands it, plans tasks with dependencies, writes the code itself, calls a planner, researcher or reviewer when they add value, splits off parallel workers only when independent parts gain from it, checks what comes back against the real diff, verifies the integrated result and delivers. A delegate only claims it is done; a task counts once the session has reviewed it.

```text
/plugin install spider-team --marketplace anderson-spider/claude-mods
```

## Use

```text
/spider-team add rate limiting to the public API
```

The run goes through Understand, Plan, Investigate, Execute, Review, Verify and Complete. The session implements by default: simple, sequential or tightly coupled work stays with it, and a worker gets a task only when it can advance in parallel with other work on files nobody else is changing. No role is a mandatory step, and only the session runs Git commands that write or publish, as your current authorization allows.

Asked to build a new project from an empty directory, the run starts it: it writes `docs/SPEC.md`, `docs/PLAN.md`, a short `AGENTS.md` and `filemap.md`, and delegates nothing until you approve the spec and the plan. Visual decisions stay with the session, which shows new screens as mockups first and reviews what was built itself; product questions the request leaves open go to you.

To stop retyping the command, turn on session mode:

| Command | What it does |
| --- | --- |
| `/spider-team on` | Every later message that asks for a change becomes tasks appended to one list, executed in order; questions are answered without a task, and an unclear message gets a one-line question. Messages sent while it works join the list. Verify runs each time the list drains. |
| `/spider-team brainstorm <topic>` | Plans the topic into a backlog and waits: refine it in the conversation, then say go. In session mode the backlog joins the list. |
| `/spider-team off` | Finishes or cancels the open tasks as you say, verifies and closes the run. |

| Agent | Model | Default effort | For | Tools |
| --- | --- | --- | --- | --- |
| `spider-planner` | Opus 5.5 (`claude-opus-5-5`) | medium | a plan for a complex decision: options, dependencies, acceptance criteria | `Read`, `Grep`, `Glob` |
| `spider-worker` | Sonnet 5.5 (`claude-sonnet-5-5`) | medium | one bounded implementation task in parallel with other work | every tool but `Agent` |
| `spider-researcher` | Haiku 5.5 (`claude-haiku-5-5`) | medium | web research, reading code, reading or writing documentation | `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `Write`, `Edit` |
| `spider-reviewer` | Opus 5.5 (`claude-opus-5-5`) | medium | reviewing a change: must-fix findings with location, evidence and impact, apart from optional ones | `Read`, `Grep`, `Glob` |

Every agent also gets `ToolSearch` and spider-progress's `step` tool when they exist. The models are full IDs, so a provider that does not serve them (Bedrock, Vertex, Foundry) fails the call instead of running another model.

## Options

Set them in `/plugin` (or `pluginConfigs["spider-team@spider-claude-mods"].options` in settings):

| Option | Default | What it sets |
| --- | --- | --- |
| `max_workers` | 2 | the most workers that run at once |
| `planner_effort`, `worker_effort`, `researcher_effort`, `reviewer_effort` | `medium` | the effort the session asks for when it calls that role: `low`, `medium`, `high`, `xhigh` or `max`, all supported by the three 5.5 models |

An effort you ask for in the conversation, for a role or a task, goes in place of the option. With [subagent-effort](../subagent-effort/README.md) active, Jev's rating replaces the effort of every subagent call, yours included: that is how the plugin works, and spider-team does not work around it. The session's own effort is yours to set with `/effort`; neither plugin changes it.

## What is enforced

- **Enforced by the agent definitions' tools**: the planner and the reviewer have no edit, shell or agent tool, so they cannot change files or Git state. The researcher has no shell, so it runs no command and changes no Git state. No agent can start agents of its own (the worker has `Agent` removed; the others do not list it).
- **Only asked in the prompts**: that the worker stays inside its brief's scope and runs no Git command that writes or publishes, and that the researcher writes only the documentation paths its brief names. A tool list cannot scope `Bash` to some commands or `Write` to some paths, and a plugin agent's `permissionMode` and `hooks` are ignored. To block Git writes technically, add deny rules such as `Bash(git commit *)` and `Bash(git push *)` to your settings: they apply to the whole session, the session itself included.
- **Checked by the session**: it reads every delivered diff before accepting it.

With [spider-progress](../spider-progress/README.md) installed, the run shows as a band under the session card and in the `/spider-agents` pane. Without it, the skill runs the same and reports nothing.

## Privacy

The skill and agents are prompts: they send nothing anywhere themselves. Briefs go to the subagents the session starts, as any delegation does.

## Tests

The plugin ships prompts only, so there are no automated tests; `claude plugin validate --strict` checks its files, and behaviour is checked in a live session. See [AGENTS.md](AGENTS.md).

## Acknowledgements

The design is inspired by `savvy-flow` from [claude-kit](https://github.com/JohnnyVizz/claude-kit) by johnnyvizz (MIT). The prompts here are our own.
