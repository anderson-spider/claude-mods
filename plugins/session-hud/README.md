# session-hud

A card above the prompt. In a terminal it has three rows:

1. A dot, green between turns and yellow with the running turn's time (`working 12s`) while one runs; the model and its effort; the context bar with its tokens (`88% · 440k/500k`), measured against the window the session compacts at (an `autoCompactWindow` smaller than the model's limit counts); the share of the input read from the prompt cache; and the output tokens.
2. The five-hour and seven-day limits, side by side: a bar of at most thirty cells lit to the percent used with a tick at the time passed, `▲N` for the points above an even pace, the time left and where the pace ends (`~85% at reset`, or `100% in 2d 7h` when it runs out first).
3. The subagents and teammates running a turn now, grouped by model (`3 agents: Sonnet 4.5 ×2 · Haiku 4.5`, `?` for a model not yet reported), left out when none runs; then the last turn's duration, the turns so far, and the session's edits and errors. The card shows no money.

From about 155 columns the context and the two windows sit as three aligned blocks under the first row: each with a thirty-cell bar over one line of figures, the context's line holding its tokens, the tokens left in the window, the cache share and the output tokens.

On the desktop app (and any surface that lays out by itself) the card is drawn with the surface's own layout instead of padded text, its bars a fixed 96 pixels:

1. The dot, model, effort and running turn; the running agents at the right.
2. The context bar with its tokens and, at the right, the last twelve turns as bars measured against the compaction window: grey for the context a turn began with, green for what it added, a dashed line on a turn a compaction the host reported came before or during; then the last turn in figures (`▲ +61k · 2.1k out`).
3. The cache share and how long ago a request read or wrote it (`cache 96% · used 40s ago`); after a model switch, which is the only time the host names the cache's lifetime, also what is left of it (`1h TTL, 59m left`, or `expired`).
4. The five-hour and seven-day windows on one line, each with its bar, tick, lead, time left and where the pace ends.
5. The last turn's duration, the turns so far, edits and errors.

```text
/plugin install session-hud --marketplace anderson-spider/claude-mods
```

Under a dark or automatic theme the card uses the design's colours; under a light or ANSI theme it keeps the theme's. A survey takes the band while it is open.

## Privacy

Everything comes from the session itself: the host's usage figures and token counts, the model that answered, the cache lifetime a model switch reports, the main session's tool results (only whether an edit succeeded or a call failed), the ids and models of the agents the session starts and the host's agent list (only whether each one is still running). Nothing is sent anywhere, and no prompt, answer, tool input or path reaches the screen.

## Tests

Pure tests call `hooks/usage.ts`, `hooks/card.ts`, `hooks/view.ts`, `hooks/desktop.ts` and `hooks/palette.ts` directly; host tests run the plugin against a fake host (`tests/host.ts`) with no network. Checks and editing pointers: [AGENTS.md](AGENTS.md).
