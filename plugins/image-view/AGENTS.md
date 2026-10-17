# image-view

Usage/privacy: [README.md](README.md). A copy of [claude-image-view](https://github.com/jarrodwatts/claude-image-view) by Jarrod Watts (MIT): keep `LICENSE` and the credit in the README and `plugin.json` `author`.

## Module map

- `hooks/register.tsx`: every `on(...)` and `$` call. `session.start` polls the prompt every 200 ms (`$.clock.every`); each poll reads the draft's `[Image #n]` tags, finds the session's image folder under Claude Code's temp root by session id, converts a non-PNG paste once with `sips`, reads the PNG size and, where pictures are not drawn, a decoded thumbnail; it writes the `images` atom only when the list changed. The `AbovePrompt` render (terminal surface, no survey) draws the tiles above what comes from `next(e)`: `Image` from the file, `Raster` half blocks, or "no preview".
- `hooks/layout.ts`: pure. `imageNumbers`, `pngSize`, `fitCells`/`fitRow` (tiles that fit the band whole, `+N` for the rest), `drawsPictures` (the renderer choice) and `blockCells` (half-block cells).
- `hooks/png.ts`: pure PNG decoder with its own inflate, box-averaged to a thumbnail (`decodeThumb`), and `fromBase64`.
- `types/index.d.ts`: the `image-view` state contract (`images`).

## Invariants

- Real pictures only where Claude Code draws them: kitty or Ghostty by name, never in tmux, screen or a background session unless `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` is set; a terminal that names itself in `TERM_PROGRAM` decides even when it inherits kitty's or Ghostty's variables; `CLAUDE_IMAGE_VIEW_RENDERER` overrides. `tests/image-view.test.ts` (`real pictures only where Claude Code draws them: kitty and Ghostty, or when forced`); the band cases after it draw `Raster` for Herdr inside Ghostty.
- A paste shows on the next poll and clears with its tags; a tile with no preview is not read again on every poll. `tests/image-view.test.ts` (`a pasted image shows without another keystroke and clears when the draft does`, `a tile with no preview is neither re-read nor redrawn on every poll`).
- The row never scrolls: tiles shrink to the band, the rest become `+N`, and a band too short draws nothing. `tests/image-view.test.ts` (`a row of tiles shrinks to fit the band so it never scrolls`, `tiles that don't fit become a +N label, and a band too short for one draws nothing`).
- Nothing leaves the machine: no `$.http`, only `id -u` and `sips` as processes.

## Checks

[Root commands](../../AGENTS.md#commands); type-check with `npm run typecheck -- image-view`.
