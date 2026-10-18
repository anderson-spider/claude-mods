# session-hud

A card above the prompt, laid out the same way in a terminal, on the desktop app and on any other surface:

1. A dot, green between turns and yellow with the running turn's time (`working 12s`) while one runs; the model and its effort; at the right, the subagents and teammates running a turn now, grouped by the agent type they were spawned as, their model and the effort of their last request (`3 agents: codex:codex-rescue Opus 5.5 · high ×2, Explore Haiku 4.5 · medium`; `?` for a model not yet reported, a part the host has not reported left out), left out when none runs; after them, the tokens every subagent and teammate request processed since the card loaded (`agents used 1.2M tokens`: input, cache read and written, and output, summed over requests), shown once one reports usage and kept after the agents end.
2. The context bar with its tokens (`47%  236k / 500k`), measured against the window the session compacts at (an `autoCompactWindow` smaller than the model's limit counts); from 85% of that window the bar and its percent turn red, a cue to run `/compact` yourself before the automatic one; at the right, the last turn in figures (`+14k sent · ▲ +94k in turn · 36k out`): what was sent at its start on top of where the turn before it ended (your message, reminders, results delivered between turns), what the turn itself added (tool results and output) and the output of all its requests. What was sent is left out when it is not known: for the first turn the card sees, after a compaction, and when a turn starts below where the one before it ended.
3. The share of the input read from the prompt cache and how long ago a request read or wrote it (`cache 96% · used 40s ago`); with a known lifetime, also what is left of it (`1h TTL, 59m left`, or `expired`). The host names the lifetime only on a model switch; the `cacheTtl` option names it before that.
4. The five-hour and seven-day windows on one line, each with a bar lit to the percent used and a tick at the time passed, `▲N` for the points above an even pace, the time left and where the pace ends (`~85% at reset`, or `100% in 2d 7h` when it runs out first).
5. The last turn's duration, the turns so far, and the session's edits and errors. The card shows no money.

The bars keep a fixed size whatever the card's width: 96 pixels drawn as SVG on the desktop, twelve cells of text in a terminal. A narrow card wraps between the parts of a line, never inside one; in a terminal, a part wider than the whole card is cut at the edge.

```text
/plugin install session-hud --marketplace anderson-spider/claude-mods
```

Option (`/plugin` → session-hud, or `pluginConfigs` in settings): `cacheTtl` (`off`, `5m`, `1h`; default `off`) is the prompt-cache lifetime your sessions write, which the host does not report until a model switch. Set, the card shows what is left of the cache from the first turn. A model switch's lifetime replaces the option's. A wrong value shows a wrong countdown, so set the lifetime your plan or settings actually write.

Under a dark or automatic theme the card uses the design's colours; under a light or ANSI theme it keeps the theme's. A survey takes the band while it is open. Another plugin that draws in the same band, such as next-steps with its suggestions, shows under the card.

## Privacy

Everything comes from the session itself: the host's usage figures and token counts, the model that answered, the cache lifetime a model switch reports, the main session's tool results (only whether an edit succeeded or a call failed), the ids, agent types, models, efforts and token counts of the agents the session starts and the host's agent list (whether each one is still running, and its type). The task description an agent was given never reaches the card. Nothing is sent anywhere, and no prompt, answer, tool input or path reaches the screen.

## Tests

Pure tests call `hooks/usage.ts`, `hooks/card.ts`, `hooks/view.ts`, `hooks/layout.ts` and `hooks/palette.ts` directly; host tests run the plugin against a fake host (`tests/host.ts`) with no network. Checks and editing pointers: [AGENTS.md](AGENTS.md).
