# hud

Three rows above the prompt, in the same order in the terminal and the app, plus suggested next prompts:

1. model, repository and branch;
2. context, cache, cache hit and agents;
3. 5-hour and 7-day limits.

Plain ESM with no `types/`. Labels are English only.

IMPORTANT: adapted from third-party work. Keep `LICENSE`, and list changes and credits in `NOTICE`.

## Modules

- `hud.mjs` is the entry module. It also reads the settings and keeps the last prompt (`prompt.submit`).
- Pure modules sit beside it: labels and palette, context, limits, cache, suggestions, info, drawing, and `render.mjs` composing `AbovePrompt`.
- The flows `suggestion-flow.mjs`, `history.mjs` and `info-refresh.mjs` take only the host callbacks they use.

## Suggestions

They come from Haiku through `$.model.complete` with the last prompt and the last answer, or from a fork of the session (`suggestionModel`).
