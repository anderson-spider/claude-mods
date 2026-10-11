# Flightdeck (vendored)

This folder is a copy of [Flightdeck](https://github.com/scasella/claude-flightdeck) 0.3.2 (commit `f31daca`), by Stephen Casella, under the MIT license in `LICENSE`. The plugin's dashboard, `/flightdeck` command, status line and the twelve options of its `userConfig` come from it. The files not listed below are unchanged.

## Local changes

`register.tsx`:

- `export const register` is `export const registerFlightdeck`, called from the crew's own `register`: a plugin has one hooks module.
- The twelve state atoms are owned by `crew` (`plugin: 'crew'`, was `'flightdeck'`): only the owner of a value writes it.
- `'../types'` is `'../../types'`.
- Every hook that calls `next` keeps its own work in `try/catch` and returns what `next` returned (or `next(e)`), so a Flightdeck failure never reaches the call or the crew's hooks on the same event. There is no pass-through `.catch`.

`core.ts`:

- `'../types'` is `'../../types'`.

`rail.tsx`, `elapsed.tsx` and `LICENSE` are byte-for-byte the upstream files.

Outside this folder:

- `plugins/crew/types/index.d.ts` is upstream `types/index.d.ts` with the state keyed `'crew'`; the manifest names it in `types`.
- `plugins/crew/tests/flightdeck.test.ts` is upstream `tests/flightdeck.test.ts` with its import at `../hooks/flightdeck/core` and `plugin: 'crew'` in `pane()`.
- The crew's `plugin.json` carries the twelve options with the upstream names and defaults.
