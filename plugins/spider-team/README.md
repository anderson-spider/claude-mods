# spider-team

`/spider-team:execute <task>` makes the session the owner and main implementer of a task: it understands it, plans tasks with dependencies, writes the code itself, calls a planner, researcher or reviewer when they add value, splits off parallel workers only when independent parts gain from it, checks what comes back against the real diff, verifies the integrated result and delivers, while a band under the session card and a `/spider-agents` pane show the run. A delegate only claims it is done; a task counts once the session has reviewed it.

```text
/plugin install spider-team --marketplace anderson-spider/claude-mods
```

## Use

```text
/spider-team:execute add rate limiting to the public API
```

The run goes through Understand, Plan, Investigate, Execute, Review, Verify and Complete. The session implements by default: simple, sequential or tightly coupled work stays with it, and a worker gets a task only when it can advance in parallel with other work on files nobody else is changing. No role is a mandatory step, and only the session runs Git commands that write or publish, as your current authorization allows.

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
| `language` | `auto` | the band and pane language: `auto` follows the Claude Code language setting, then the system locale; `pt-BR` or `en` fix it |
| `autoOpen` | `team` | when the pane opens on its own: `team` when a run starts, `any` when a subagent starts with none running, `off` only with `/spider-agents`; a pane you close stays closed for the agents already at work |
| `showCost`, `showTokens`, `showContext` | on | the estimated cost, the token counts and the context of each agent |
| `animations` | on | a spinner beside running agents; off keeps a fixed mark |
| `historyLimit` | 200 | how many agents the pane remembers (20 to 1000) |

An invalid band or pane option falls back to its default. An effort you ask for in the conversation, for a role or a task, goes in place of the option. With [subagent-effort](../subagent-effort/README.md) active, Jev's rating replaces the effort of every subagent call, yours included: that is how the plugin works, and spider-team does not work around it. The session's own effort is yours to set with `/effort`; neither plugin changes it.

## What is enforced

- **Enforced by the agent definitions' tools**: the planner and the reviewer have no edit, shell or agent tool, so they cannot change files or Git state. The researcher has no shell, so it runs no command and changes no Git state. No agent can start agents of its own (the worker has `Agent` removed; the others do not list it).
- **Only asked in the prompts**: that the worker stays inside its brief's scope and runs no Git command that writes or publishes, and that the researcher writes only the documentation paths its brief names. A tool list cannot scope `Bash` to some commands or `Write` to some paths, and a plugin agent's `permissionMode` and `hooks` are ignored. To block Git writes technically, add deny rules such as `Bash(git commit *)` and `Bash(git push *)` to your settings: they apply to the whole session, the session itself included.
- **Checked by the session**: it reads every delivered diff before accepting it.

## Progress band and agents pane

- **Band**: while a spider-team run is open, one line above the prompt: a mark (a spinner while agents run, then ✓, ✗ or – once the run ends), the plan's counts (accepted / running or in review / left, then failed and cancelled with the run when any; a task a replan drops or Main cancels leaves the counts), the tasks in progress with their owners and the run's running agents with the latest tool one of them called. A narrow band drops the tool, then the tasks. `×N`, the run's agents, toggles the pane; `✕` hides the band until the next run.
- **Pane**: `/spider-agents` toggles it, `/spider-agents open` opens or focuses it, `/spider-agents close` closes it. A header with the run's title and phase and how many agents run and finished, then bordered sections in your theme's colours:
  - **Plan**: the tasks as a tree (a task hangs under the last task it comes after) with owner and state, the agent on it and its steps, what a blocked task waits for, a failed task's last error and an accepted task's evidence.
  - **Running**: each running agent with its task, model and effort (planned → actual when they differ; planned is the role's default, since the host does not report the effort a call asked for, so a role effort set in the options below or a rating from subagent-effort shows as a change), time, context, steps, tokens sent and received and estimated cost, then what it is on: its last step note, its latest tools, its call count and its failed calls. A wide pane keeps the figures on the agent's line; a narrow one moves them to the next.
  - **Recent**: the run's finished agents, newest first, with how long they ran, why a failed one ended and how long ago.
  - **Other agents**: the session's agents outside the run.
  - **Last 15 minutes**: a bar per agent over time, running, finished or failed.
  - **Totals**: tokens, cost and context of the session's main thread, its subagents and the whole session.
- **Outside a run** the pane still lists every subagent; the band stays hidden.
- **With session-hud** the band sits right under its card when spider-team comes after session-hud in your settings, which a later install does; listed before it, the band draws above the card.

### What it shows and what it does not

Everything comes from the session: the host's per-request token counts, the model and effort each request reported, how each agent's turn ended, and what the session and its agents report through the `progress` and `step` tools. A figure the host never reported is left out (the totals read `N/A`). The pane counts the tools each subagent calls and whether they failed, except calls another plugin's hook answers before this one sees them.

- **Cost** is an estimate from token counts and a dated list-price table (`hooks/prices.ts`), with cache writes at the 5-minute rate: a lower bound, never a bill. A model the table does not list has no cost.
- **Context** is a percent only for the main session, whose window the host reports; a subagent shows its context in tokens.

spider-progress, the plugin that drew them before, is part of spider-team now. If you had it installed, uninstall it (`/plugin uninstall spider-progress@spider-claude-mods`; `scripts/bootstrap.sh` does it for you) so the band and pane are not drawn twice, and set its options again here.

## Privacy

The skill and agents are prompts: they send nothing anywhere themselves. Briefs go to the subagents the session starts, as any delegation does. The band and pane send and save nothing: their state lives in the session's memory and is cleared when it ends. The band shows the run's title, which the session writes; the pane shows task titles, agent types, step notes and tool names, never prompts, tool inputs or answers.

## Tests

The hooks have pure tests that call the modules directly and host tests that run the plugin against a fake host (`tests/host.ts`) with no model calls, so they do not prove what a real session reports. The skill and agents are prompts: `claude plugin validate --strict` checks their files, and their behaviour is checked in a live session. See [AGENTS.md](AGENTS.md).

## Acknowledgements

The design is inspired by `savvy-flow` and `savvy-progress` from [claude-kit](https://github.com/JohnnyVizz/claude-kit) by johnnyvizz (MIT). The prompts and code here are our own.
