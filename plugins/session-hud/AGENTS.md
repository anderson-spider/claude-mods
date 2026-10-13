# session-hud

Usage/privacy: [README.md](README.md).

## Module map

- `hooks/register.tsx`: every `on(...)`, atom and `$` call. `session.start` primes the card from `$.session.model()`, `$.session.usage()`, the clock and the theme; `session.measure` replaces the context, the windows and the cost; `turn.start` keeps the cost the main session's turn began at; `turn.step` and `turn.complete` of the main session (no `agentId`) bring the effort, the answering model, the cache share and the turn's duration; a post-result `tool.call` hook counts the main session's edits and errors; `config.set` of `theme` repaints. The `AbovePrompt` render reads the atoms only (its own and the crew's `crew.plans` and `crew.agents`) and yields to a survey.
- `hooks/card.ts`: pure card updates (`measured`, `stepped`, `completed`, `tooled`). `hooks/usage.ts`: pure figures (`paceOf`: the elapsed-time tick, the points ahead of an even pace, the projection at reset and the time to 100%; `cacheShare`, `span`, `money`). `hooks/view.ts`: the card as rows from one snapshot (`cardView`, `crewSummary`, `modelName`), sized to `bodyColumns`; the two windows sit side by side from 72 inner cells. `hooks/palette.ts`: a style to its paint, the design's fixed colours under a full-colour dark or automatic theme and theme keys under any other.
- `types/index.d.ts`: the `session-hud` state contract (`card`, `now`, `palette`). The crew is a dependency: its contract types the crew atoms the card reads.

## Invariants

- Observation never changes what the host answered: every hook passes `next(e)`'s result on as it came, and an observation failure is one debug line. `tests/register.test.ts` (`main-session edits and errors are counted after their result, which goes on unchanged; a subagent counts nothing`).
- Only figures, Claude model names (`modelName`: family and version, anything else `?`), known efforts, step ids and owners reach the screen; never a prompt, an answer, a tool input, a path or a cost line from another source. `tests/view.test.ts` (`only Claude model ids reach the screen, named by family and version`, `a spend limit and malformed figures never reach the screen as numbers`), `tests/register.test.ts` (`the card draws the session as measured: model, effort, context, cache, cost, both windows and the turn`).
- A figure the host has not reported is left out, never drawn as zero; the card is empty with nothing to show. `tests/view.test.ts` (`what the host has not reported is left out instead of drawn as zero`).
- The pace: the tick is the share of the window passed; `▲N` is the whole points used above an even pace; the projection appears once 2% of the window has passed, and `100% in` replaces it when the pace reaches 100 before the reset. `tests/usage.test.ts` (`a window half passed at 74% is 24 points ahead and reaches 100% before its reset`, `a window that just began projects nothing past what is used`).

## Checks

[Root commands](../../AGENTS.md#commands); type-check with `mise exec -- tsc -p plugins/session-hud/tsconfig.json`. `tests/host.ts` is the host fake (`world`, `start`, `step`, `band`); a test that needs the crew's atoms passes them to `world`.
