# spider-progress

A band under the session card that follows a [spider-team](../spider-team/README.md) run, and a `/spider-agents` pane with every subagent the session starts.

```text
/plugin install spider-progress --marketplace anderson-spider/claude-mods
```

## Use

- **Band**: while a spider-team run is open, three lines above the prompt: the run's title; a bar of the tasks the session accepted after review (no percent before the plan has tasks); the phase, accepted/total tasks (a task a replan drops leaves the total; one a cancelled run leaves open stays in it) and the run's running agents. `×N`, the run's agents, toggles the pane; `✕` hides the band until the next run.
- **Pane**: `/spider-agents` toggles it, `/spider-agents open` opens or focuses it, `/spider-agents close` closes it. The run's agents come first, then the session's other agents under `OTHER AGENTS`. Each agent shows its role icon, model, effort (planned → actual when they differ; planned is spider-team's default for the role, since the host does not report the effort a call asked for, so a role effort set in spider-team's options or a rating from subagent-effort shows as a change), status, steps it reported with their percent, tokens, context, estimated cost and time; then the run's tasks (blocked in yellow, failed in red with the last error, accepted with their evidence) and the totals of the session's main thread, its subagents and the whole session. `c` switches between compact and expanded.
- **Without spider-team** the pane still lists every subagent; the band stays hidden.
- **With session-hud** the band sits right under its card when spider-progress comes after session-hud in your settings, which a later install does; listed before it, the band draws above the card.

Options (`/plugin` → spider-progress, or `pluginConfigs` in settings): `language` (`auto`, `pt-BR`, `en`), `autoOpen` (`team` opens the pane when a run starts, `any` when a subagent starts with none running, `off`; a pane you close stays closed for the agents already at work), `showCost`, `showTokens`, `showContext`, `animations`, `compactMode`, `historyLimit` (20 to 1000). An invalid value falls back to its default.

## What it shows and what it does not

Everything comes from the session: the host's per-request token counts, the model and effort each request reported, how each agent's turn ended, and what spider-team and its workers report through this plugin's `progress` and `step` tools. A figure the host never reported reads `N/A`.

- **Cost** is an estimate from token counts and a dated list-price table (`hooks/prices.ts`), with cache writes at the 5-minute rate: a lower bound, never a bill. A model the table does not list has no cost.
- **Context** is a percent only for the main session, whose window the host reports; a subagent shows its context in tokens.

## Privacy

Nothing is sent or saved: the state lives in the session's memory and is cleared when it ends. The band shows the run's title, which the session writes; the pane shows task titles and agent types, never prompts or answers.

## Tests

Pure tests call the modules directly; host tests run the plugin against a fake host (`tests/host.ts`) with no model calls, so they do not prove what a real session reports. See [AGENTS.md](AGENTS.md).

## Acknowledgements

The design is inspired by `savvy-progress` from [claude-kit](https://github.com/JohnnyVizz/claude-kit) by johnnyvizz (MIT). The code here is our own.
