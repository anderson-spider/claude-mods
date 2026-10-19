# spider-progress

A band under the session card that follows a [spider-team](../spider-team/README.md) run, and a `/spider-agents` pane with every subagent the session starts.

```text
/plugin install spider-progress --marketplace anderson-spider/claude-mods
```

## Use

- **Band**: while a spider-team run is open, one line above the prompt: a mark (a spinner while agents run, then ✓, ✗ or – once the run ends), the plan's counts (accepted / running or in review / left, then failed and cancelled with the run when any; a task a replan drops or Main cancels leaves the counts), the tasks in progress with their owners and the run's running agents with the latest tool one of them called. A narrow band drops the tool, then the tasks. `×N`, the run's agents, toggles the pane; `✕` hides the band until the next run.
- **Pane**: `/spider-agents` toggles it, `/spider-agents open` opens or focuses it, `/spider-agents close` closes it. A header with the run's title and phase and how many agents run and finished, then bordered sections in your theme's colours:
  - **Plan**: the tasks as a tree (a task hangs under the last task it comes after) with owner and state, the agent on it and its steps, what a blocked task waits for, a failed task's last error and an accepted task's evidence.
  - **Running**: each running agent with its task, model and effort (planned → actual when they differ; planned is spider-team's default for the role, since the host does not report the effort a call asked for, so a role effort set in spider-team's options or a rating from subagent-effort shows as a change), time, context, steps, tokens sent and received and estimated cost, then what it is on: its last step note, its latest tools, its call count and its failed calls. A wide pane keeps the figures on the agent's line; a narrow one moves them to the next.
  - **Recent**: the run's finished agents, newest first, with how long they ran, why a failed one ended and how long ago.
  - **Other agents**: the session's agents outside the run.
  - **Last 15 minutes**: a bar per agent over time, running, finished or failed.
  - **Totals**: tokens, cost and context of the session's main thread, its subagents and the whole session.
  
  `c` switches between the full view and a compact one (the plan's counts and a line per agent).
- **Without spider-team** the pane still lists every subagent; the band stays hidden.
- **With session-hud** the band sits right under its card when spider-progress comes after session-hud in your settings, which a later install does; listed before it, the band draws above the card.

Options (`/plugin` → spider-progress, or `pluginConfigs` in settings): `language` (`auto`, `pt-BR`, `en`), `autoOpen` (`team` opens the pane when a run starts, `any` when a subagent starts with none running, `off`; a pane you close stays closed for the agents already at work), `showCost`, `showTokens`, `showContext`, `animations`, `compactMode`, `historyLimit` (20 to 1000). An invalid value falls back to its default.

## What it shows and what it does not

Everything comes from the session: the host's per-request token counts, the model and effort each request reported, how each agent's turn ended, and what spider-team and its workers report through this plugin's `progress` and `step` tools. A figure the host never reported is left out (the totals read `N/A`). The pane counts the tools each subagent calls and whether they failed, except calls another plugin's hook answers before this one sees them.

- **Cost** is an estimate from token counts and a dated list-price table (`hooks/prices.ts`), with cache writes at the 5-minute rate: a lower bound, never a bill. A model the table does not list has no cost.
- **Context** is a percent only for the main session, whose window the host reports; a subagent shows its context in tokens.

## Privacy

Nothing is sent or saved: the state lives in the session's memory and is cleared when it ends. The band shows the run's title, which the session writes; the pane shows task titles, agent types, step notes and tool names, never prompts, tool inputs or answers.

## Tests

Pure tests call the modules directly; host tests run the plugin against a fake host (`tests/host.ts`) with no model calls, so they do not prove what a real session reports. See [AGENTS.md](AGENTS.md).

## Acknowledgements

The design is inspired by `savvy-progress` from [claude-kit](https://github.com/JohnnyVizz/claude-kit) by johnnyvizz (MIT). The code here is our own.
