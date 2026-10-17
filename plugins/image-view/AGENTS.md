# image-view

Usage/privacy: [README.md](README.md). A copy of [claude-image-view](https://github.com/jarrodwatts/claude-image-view) by Jarrod Watts (MIT): keep `LICENSE` and the credit in the README and `plugin.json` `author`.

## Module map

- `hooks/register.tsx`: every `on(...)` and `$` call. `session.start` polls the prompt every 200 ms (`$.clock.every`); each poll reads the draft's `[Image #n]` tags, finds the session's image folder under Claude Code's temp root by session id, converts a non-PNG paste once with `sips`, reads the PNG size and, where pictures are not drawn, a decoded thumbnail; it writes the `images` atom only when the list changed. The `AbovePrompt` render (terminal surface, no survey) draws the tiles above what comes from `next(e)`: `Image` from the file, `Raster` half blocks, or "no preview". The `ToolGroup` render opens a folded run that holds a read image (`isExpanded`); the `ToolUse` render of a finished `Read` of an image draws the engine's row with the picture under it, from a per-call thumbnail at most `READ_THUMB_PIXELS` on its longest side (`previewFor` starts it on the first draw and `$.ui.invalidate` redraws once it is made), with a `Button` under it whose press runs `openImage` (`open`, else `xdg-open`, on the file read while it exists, else the thumbnail).
- `hooks/layout.ts`: pure. `imageNumbers`, `pngSize`, `fitCells`/`fitRow` (tiles that fit the band whole, `+N` for the rest), `drawsPictures` (the renderer choice), `blockCells` (half-block cells), `readImagePath` (the image a `Read` opens), `fileName` `READ_ROWS`/`READ_COLUMNS` (the transcript thumbnail's box) and `READ_THUMB_PIXELS`.
- `hooks/png.ts`: pure PNG decoder with its own inflate, box-averaged to a thumbnail (`decodeThumb`), and `fromBase64`.
- `types/index.d.ts`: the `image-view` state contract (`images`).

## Invariants

- Real pictures only where Claude Code draws them: kitty or Ghostty by name, never in tmux, screen or a background session unless `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` is set; a terminal that names itself in `TERM_PROGRAM` decides even when it inherits kitty's or Ghostty's variables; `CLAUDE_IMAGE_VIEW_RENDERER` overrides. `tests/image-view.test.ts` (`real pictures only where Claude Code draws them: kitty and Ghostty, or when forced`); the band cases after it draw `Raster` for Herdr inside Ghostty.
- A paste shows on the next poll and clears with its tags; a tile with no preview is not read again on every poll. `tests/image-view.test.ts` (`a pasted image shows without another keystroke and clears when the draft does`, `a tile with no preview is neither re-read nor redrawn on every poll`).
- The row never scrolls: tiles shrink to the band, the rest become `+N`, and a band too short draws nothing. `tests/image-view.test.ts` (`a row of tiles shrinks to fit the band so it never scrolls`, `tiles that don't fit become a +N label, and a band too short for one draws nothing`).
- A read image is drawn only under a finished `Read` of an image file, from a thumbnail made per call, so a file written again later does not change earlier rows; a running, failed or interrupted call and any other row are drawn as the engine draws them, and only a folded run holding a read image is opened. `tests/image-view.test.ts` (`only a Read of an image file is an image Claude read`, `a read that is running, failed or is not an image draws the row alone`, `a folded run of reads opens when it holds an image, and stays folded otherwise`); the cases before them draw it from the thumbnail or in half blocks and open the file from its name.
- Nothing leaves the machine: no `$.http`; the processes are `id -u`, `sips`, and `open` or `xdg-open` only on a press of a read image's file name.

## Checks

[Root commands](../../AGENTS.md#commands); type-check with `npm run typecheck -- image-view`.
