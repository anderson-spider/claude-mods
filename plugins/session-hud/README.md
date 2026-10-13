# session-hud

A three-row card above the prompt:

1. A dot, green between turns and yellow with the running turn's time (`working 12s`) while one runs; the model and its effort; the context bar with its tokens (`88% · 440k/500k`), measured against the window the session compacts at (an `autoCompactWindow` smaller than the model's limit counts); the share of the input read from the prompt cache; and the session's cost (`session $4.59`).
2. The five-hour and seven-day limits, side by side: a bar of at most thirty cells lit to the percent used with a tick at the time passed, `▲N` for the points above an even pace, the time left and where the pace ends (`~85% at reset`, or `100% in 2d 7h` when it runs out first).
3. The last turn's duration, the crew's running helpers, the session's edits and errors and what the last turn cost; on the right, the crew's open plans (`done`, `running`, `left`) and the running steps.

```text
/plugin install session-hud --marketplace anderson-spider/claude-mods
```

It requires the crew plugin, which no longer draws above the prompt itself; `/crew-hud` still opens the crew's pane. Under a dark or automatic theme the card uses the design's colours; under a light or ANSI theme it keeps the theme's. A survey takes the band while it is open.

## Privacy

Everything comes from the session itself: the host's usage figures, the model that answered, the main session's tool results (only whether an edit succeeded or a call failed) and the crew's prepared plan and helper state. Nothing is sent anywhere, and no prompt, answer, tool input or path reaches the screen.

## Tests

Pure tests call `hooks/usage.ts`, `hooks/card.ts`, `hooks/view.ts` and `hooks/palette.ts` directly; host tests run the plugin against a fake host (`tests/host.ts`) with no network. Checks and editing pointers: [AGENTS.md](AGENTS.md).
