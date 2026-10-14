# session-hud

A three-row card above the prompt:

1. A dot, green between turns and yellow with the running turn's time (`working 12s`) while one runs; the model and its effort; the context bar with its tokens (`88% · 440k/500k`), measured against the window the session compacts at (an `autoCompactWindow` smaller than the model's limit counts); the share of the input read from the prompt cache; the output tokens; and the session's cost, its hourly rate and age (`session $4.59 · $15.30/h · 18m`).
2. The five-hour and seven-day limits, side by side: a bar of at most thirty cells lit to the percent used with a tick at the time passed, `▲N` for the points above an even pace, the time left and where the pace ends (`~85% at reset`, or `100% in 2d 7h` when it runs out first).
3. The subagents and teammates running a turn now, grouped by model (`3 agents: Sonnet 4.5 ×2 · Haiku 4.5`, `?` for a model not yet reported), left out when none runs; then the last turn's duration, the turns so far, the session's edits and errors and what the last turn cost.

From about 150 columns the context and the two windows sit as three aligned blocks under the first row: each with a thirty-cell bar, and the context's block adds the tokens left in the window, the cache share and the output tokens.

```text
/plugin install session-hud --marketplace anderson-spider/claude-mods
```

Under a dark or automatic theme the card uses the design's colours; under a light or ANSI theme it keeps the theme's. A survey takes the band while it is open.

## Privacy

Everything comes from the session itself: the host's usage figures, the model that answered, the main session's tool results (only whether an edit succeeded or a call failed), the ids and models of the agents the session starts and the host's agent list (only whether each one is still running). Nothing is sent anywhere, and no prompt, answer, tool input or path reaches the screen.

## Tests

Pure tests call `hooks/usage.ts`, `hooks/card.ts`, `hooks/view.ts` and `hooks/palette.ts` directly; host tests run the plugin against a fake host (`tests/host.ts`) with no network. Checks and editing pointers: [AGENTS.md](AGENTS.md).
