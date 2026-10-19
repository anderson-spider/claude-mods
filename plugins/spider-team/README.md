# spider-team

`/spider-team:execute <task>` makes the session the owner and main implementer of a task: it understands it, plans tasks with dependencies, writes the code itself, calls a planner, researcher or reviewer when they add value, splits off parallel workers only when independent parts gain from it, checks what comes back against the real diff, verifies the integrated result and delivers, while a `/spider-agents` pane shows the run. A delegate only claims it is done; a task counts once the session has reviewed it.

```text
/plugin install spider-team --marketplace anderson-spider/claude-mods
```

## Use

```text
/spider-team:execute add rate limiting to the public API
```

The run goes through Understand, Plan, Investigate, Execute, Review, Verify and Complete. The session implements by default: simple, sequential or tightly coupled work stays with it, and a worker gets a task only when it can advance in parallel with other work on files nobody else is changing. No role is a mandatory step except one: before opening a PR or MR, the session always has the reviewer read the whole diff and fixes what it must, and only the session runs Git commands that write or publish, as your current authorization allows.

Asked to build a new project from an empty directory, the run starts it: it writes `docs/SPEC.md`, `docs/PLAN.md`, a short `AGENTS.md` and `filemap.md`, and delegates nothing until you approve the spec and the plan. Visual decisions stay with the session, which shows new screens as mockups first and reviews what was built itself; product questions the request leaves open go to you.

Each mode is its own skill:

| Command | What it does |
| --- | --- |
| `/spider-team:execute <task>` | One run of the task through the seven phases. |
| `/spider-team:brainstorm <topic>` | Plans the topic into a backlog and waits: refine it in the conversation, then say go. In team mode the backlog joins the list. |
| `/spider-team:team-on [subject]` | Team mode, to stop retyping the command: every later message that asks for a change becomes tasks appended to one list, executed in order; questions are answered without a task, and an unclear message gets a one-line question. Messages sent while it works join the list. Verify runs each time the list drains. |
| `/spider-team:team-off` | Closes team mode: finishes or cancels the open tasks as you say, verifies and closes the run. |

| Agent | Model | Default effort | For | Tools |
| --- | --- | --- | --- | --- |
| `spider-planner` | Opus 5.5 (`claude-opus-5-5`) | medium | a plan for a complex decision: options, dependencies, acceptance criteria | `Read`, `Grep`, `Glob` |
| `spider-worker` | Sonnet 5.5 (`claude-sonnet-5-5`) | medium | one bounded implementation task in parallel with other work | every tool but `Agent` |
| `spider-researcher` | Haiku 5.5 (`claude-haiku-5-5`) | medium | web research, reading code, reading or writing documentation | `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `Write`, `Edit` |
| `spider-reviewer` | Opus 5.5 (`claude-opus-5-5`) | medium | reviewing a change: must-fix findings with location, evidence and impact, apart from optional ones | `Read`, `Grep`, `Glob` |

Every agent also gets `ToolSearch` and the plugin's `step` tool, through which it reports its progress to the pane. The models are full IDs, so a provider that does not serve them (Bedrock, Vertex, Foundry) fails the call instead of running another model.

## Options

Set them in `/plugin` (or `pluginConfigs["spider-team@spider-claude-mods"].options` in settings):

| Option | Default | What it sets |
| --- | --- | --- |
| `max_workers` | 2 | the most workers that run at once |
| `planner_effort`, `worker_effort`, `researcher_effort`, `reviewer_effort` | `medium` | the effort the session asks for when it calls that role: `low`, `medium`, `high`, `xhigh` or `max`, all supported by the three 5.5 models |
| `language` | `auto` | the pane language: `auto` follows the Claude Code language setting, then the system locale; `pt-BR` or `en` fix it |
| `autoOpen` | `team` | when the pane opens on its own: `team` when a run starts, `any` when a subagent starts with none running, `off` only with `/spider-agents`; a pane you close stays closed for the agents already at work |
| `showCost`, `showTokens`, `showContext` | on | the estimated cost, the token counts and the context of each agent |
| `animations` | on | a spinner beside running agents and a moving rail into the running card; off keeps them still |
| `historyLimit` | 200 | how many agents the pane remembers (20 to 1000) |

An invalid pane option falls back to its default. An effort you ask for in the conversation, for a role or a task, goes in place of the option. With [subagent-effort](../subagent-effort/README.md) active, Jev's rating replaces the effort of every subagent call, yours included: that is how the plugin works, and spider-team does not work around it. The session's own effort is yours to set with `/effort`; neither plugin changes it.

## What is enforced

- **Enforced by the agent definitions' tools**: the planner and the reviewer have no edit, shell or agent tool, so they cannot change files or Git state. The researcher has no shell, so it runs no command and changes no Git state. No agent can start agents of its own (the worker has `Agent` removed; the others do not list it).
- **Only asked in the prompts**: that the worker stays inside its brief's scope and runs no Git command that writes or publishes, and that the researcher writes only the documentation paths its brief names. A tool list cannot scope `Bash` to some commands or `Write` to some paths, and a plugin agent's `permissionMode` and `hooks` are ignored. To block Git writes technically, add deny rules such as `Bash(git commit *)` and `Bash(git push *)` to your settings: they apply to the whole session, the session itself included.
- **Checked by the session**: it reads every delivered diff before accepting it.

## Agents pane

- **Pane**: `/spider-agents` toggles it, `/spider-agents open` opens or focuses it, `/spider-agents close` closes it, `/spider-agents clear` forgets the run, the agents and their usage. The run survives `/reload-plugins`, and an open run is saved so a restarted app or a resumed session shows it again. A header with a `SPIDER` badge, the run's title and phase and how many of its agents run, then cards in your theme's colours, joined by a rail that runs while agents work (with `animations` on):
  - **Session**: Main's model and effort, whether it is working, its context as a gauge and its tokens, then the estimated cost of Main, the subagents and the session, and the run's time.
  - **Plan**: accepted of the planned tasks and a gauge, then the tasks as a tree (a task hangs under the last task it comes after) with owner and state, the agent on it and its steps, what a blocked task waits for, a failed task's last error and an accepted task's evidence.
  - **Agents · running**: each running agent in its role's colour with its model, one block per attempt at its task (earlier ones green or red), its time and task, then what it is on: effort (planned → actual when they differ; planned is the role's default, since the host does not report the effort a call asked for, so a role effort set in the options below or a rating from subagent-effort shows as a change), steps, latest tools, call count and failed calls, context, tokens and cost.
  - **Agents · finished**: the session's finished agents, newest first, with how long they ran, why a failed one ended and how long ago.
  - **Agents · planned**: the role tasks no agent has taken yet, with the role's model.
  - **Last 15 minutes**: a lane for Main and each of the four roles, always there and empty while idle, then any other agent type that worked, lit in the minutes it worked.
- On the terminal the cards are drawn with box characters; on the desktop as one picture with outlined plates, in light or dark colours by the system's scheme. A pane short of rows leaves out the timeline first, then the finished and the planned agents.
- **Outside a run** the pane still lists every subagent.

### What it shows and what it does not

Everything comes from the session: the host's per-request token counts, the model and effort each request reported, how each agent's turn ended, and what the session and its agents report through the `progress` and `step` tools. A figure the host never reported is left out (the totals read `N/A`). The pane counts the tools each subagent calls and whether they failed, except calls another plugin's hook answers before this one sees them.

- **Cost** is an estimate from token counts and a dated list-price table (`hooks/prices.ts`), with cache writes at the 5-minute rate: a lower bound, never a bill. A model the table does not list has no cost.
- **Context** is a percent only for the main session, whose window the host reports; a subagent shows its context in tokens.

spider-progress, the plugin that drew them before, is part of spider-team now. If you had it installed, uninstall it (`/plugin uninstall spider-progress@spider-claude-mods`; `scripts/bootstrap.sh` does it for you) so the pane is not drawn twice, and set its options again here.

## Privacy

The skill and agents are prompts: they send nothing anywhere themselves. Briefs go to the subagents the session starts, as any delegation does. The pane sends nothing. Its agents and usage live in the session's memory and are cleared when it ends; the open run (its title, phase, task titles, criteria, evidence and errors) is also saved in the plugin's store under your Claude Code configuration directory, one entry per session, removed when the run closes or after 7 days, at most 20 sessions; `/spider-agents clear` removes this session's. It shows the run's title, which the session writes, task titles, agent types, step notes and tool names, never prompts, tool inputs or answers.

## Tests

The hooks have pure tests that call the modules directly and host tests that run the plugin against a fake host (`tests/host.ts`) with no model calls, so they do not prove what a real session reports. The skill and agents are prompts: `claude plugin validate --strict` checks their files, and their behaviour is checked in a live session. See [AGENTS.md](AGENTS.md).

## Acknowledgements

The design is inspired by `savvy-flow` and `savvy-progress` from [claude-kit](https://github.com/JohnnyVizz/claude-kit) by johnnyvizz (MIT). The prompts and code here are our own.
