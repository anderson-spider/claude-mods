# session-hud

A card above the prompt, laid out the same way in a terminal, on the desktop app and on any other surface:

1. A dot, green between turns and yellow with the running turn's time (`working 12s`) while one runs; the model and its effort; at the right, the subagents and teammates running a turn now, grouped by model (`3 agents: Sonnet 4.5 ×2 · Haiku 4.5`, `?` for a model not yet reported), left out when none runs.
2. The context bar with its tokens (`47%  236k / 500k`), measured against the window the session compacts at (an `autoCompactWindow` smaller than the model's limit counts); at the right, the last twelve turns as bars measured against that window: grey for the context a turn began with, green for what it added, a dashed line on a turn a compaction the host reported came before or during; then the last turn in figures (`▲ +61k · 2.1k out`).
3. The share of the input read from the prompt cache and how long ago a request read or wrote it (`cache 96% · used 40s ago`); after a model switch, which is the only time the host names the cache's lifetime, also what is left of it (`1h TTL, 59m left`, or `expired`).
4. The five-hour and seven-day windows on one line, each with a bar lit to the percent used and a tick at the time passed, `▲N` for the points above an even pace, the time left and where the pace ends (`~85% at reset`, or `100% in 2d 7h` when it runs out first).
5. The last turn's duration, the turns so far, and the session's edits and errors. The card shows no money.

The bars keep a fixed size whatever the card's width: 96 pixels drawn as SVG on the desktop, twelve cells of text in a terminal, where the turn history is a grid of two rows of block characters. A narrow card wraps between the parts of a line, never inside one; in a terminal, a part wider than the whole card is cut at the edge.

```text
/plugin install session-hud --marketplace anderson-spider/claude-mods
```

Under a dark or automatic theme the card uses the design's colours; under a light or ANSI theme it keeps the theme's. A survey takes the band while it is open.

## Privacy

Everything comes from the session itself: the host's usage figures and token counts, the model that answered, the cache lifetime a model switch reports, the main session's tool results (only whether an edit succeeded or a call failed), the ids and models of the agents the session starts and the host's agent list (only whether each one is still running). Nothing is sent anywhere, and no prompt, answer, tool input or path reaches the screen.

## Tests

Pure tests call `hooks/usage.ts`, `hooks/card.ts`, `hooks/view.ts`, `hooks/layout.ts` and `hooks/palette.ts` directly; host tests run the plugin against a fake host (`tests/host.ts`) with no network. Checks and editing pointers: [AGENTS.md](AGENTS.md).
