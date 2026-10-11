# Flightdeck (vendored)

This folder is a copy of [Flightdeck](https://github.com/scasella/claude-flightdeck) 0.3.2 (commit `f31daca`), by Stephen Casella, under the MIT license in `LICENSE`. The plugin's dashboard, status line and the twelve options of its `userConfig` come from it; the command is local (`/crew:panel`, below). The files not listed below are unchanged.

## Local changes

`register.tsx`:

- `export const register` is `export const registerFlightdeck`, called from the crew's own `register`: a plugin has one hooks module.
- The twelve state atoms are owned by `crew` (`plugin: 'crew'`, was `'flightdeck'`): only the owner of a value writes it. A thirteenth, `panel` (`{ isVisible, placement }` or null), holds the session's choice of where and whether the panel shows.
- `'../types'` is `'../../types'`.
- The `/flightdeck` command (`$.command.register` and its `command.run` hook) is replaced by `/crew:panel`: `commands/panel.md` (a fallback body, `disable-model-invocation`) and an `on('command.run', { command: 'crew:panel' })` hook with a `.catch`. It toggles, shows and hides, switches between the host pane (`side`) and the band (`prompt`), resets and sets the layout.
- The choice is kept in `$.store` (key `panel`, `{ v: 1, isVisible, placement }`) and seeded in `session.start`, in its own `try` after the existing work: the stored pick, else `openOnStart` and `placement`. `openOnStart` no longer opens the pane by itself; it seeds the choice.
- A `ui.render` hook for `AbovePrompt` draws the summary in prompt mode, only over the engine's own band (any other tree beneath is returned as it is). A `ui.close` hook on the pane saves hidden when the person closes it.
- The `isMini` branch of the `Pane` hook is `drawSummary`, with `loadDeck` (the reads), `makeClock`, `verdictColor`, `statusColor` and `glyph` moved to module level so the pane and the band share them; its "more agents" hint names `/crew:panel`.
- Every hook that calls `next` keeps its own work in `try/catch` and returns what `next` returned (or `next(e)`), so a Flightdeck failure never reaches the call or the crew's hooks on the same event. There is no pass-through `.catch`.

`core.ts`:

- `'../types'` is `'../../types'`.
- `Config.placement` and its `parseConfig` line; the pure `PANEL_USAGE`, `parsePanelArgs`, `choiceOf`, `storedChoice` and `choiceAfterClose` for `/crew:panel` and the stored choice.

`rail.tsx`, `elapsed.tsx` and `LICENSE` are byte-for-byte the upstream files.

Outside this folder:

- `plugins/crew/types/index.d.ts` is upstream `types/index.d.ts` with the state keyed `'crew'`, and with `Placement`, `PanelChoice` and the `panel` key added; the manifest names it in `types`. The crew's own Codex engine adds `CodexJobSummary`, the `codexJobs` key and an `McpToolInputs` block for its three `mcp__crew__codex*` tools, none of them from upstream.
- `plugins/crew/tests/flightdeck.test.ts` is upstream `tests/flightdeck.test.ts` with its import at `../hooks/flightdeck/core` and `plugin: 'crew'` in `pane()`, plus tests of the `placement` option, the command's arguments and the stored choice.
- The crew's `plugin.json` carries the twelve options with the upstream names and defaults, and a thirteenth, `placement` (`side` or `prompt`, default `side`); the `openOnStart` and `layout` descriptions say how the command and the stored pick change them.
