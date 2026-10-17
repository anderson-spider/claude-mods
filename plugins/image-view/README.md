# image-view

Shows images in the terminal, as the desktop app does: thumbnails of the images you paste above the prompt, instead of bare `[Image #1]` tags, and each image Claude reads (a screenshot, a render to compare) drawn under its `Read` row in the transcript.

Based on [claude-image-view](https://github.com/jarrodwatts/claude-image-view) by Jarrod Watts, under the MIT license (see [LICENSE](LICENSE)). This copy adds the images Claude reads, and draws half blocks instead of the `[Image #n]` text in a terminal that runs inside Ghostty or kitty but is not one of them.

```text
/plugin install image-view@spider-claude-mods
```

Uninstall the original first if you have it (`/plugin uninstall image-view@claude-image-view`): both draw the same band.

## What you see

Paste one or more images and a row of thumbnails sits above the prompt, each labelled with the number of its tag:

```text
╭────────────────────────╮ ╭────────────╮
│                        │ │            │
│      (screenshot)      │ │  (photo)   │
│                        │ │            │
│           #1           │ │     #2     │
╰────────────────────────╯ ╰────────────╯
❯ why is the header misaligned here [Image #1] vs [Image #2]
```

- Thumbnails appear as soon as you paste, without another keystroke.
- They keep their shape: wide screenshots stay wide, phone shots stay tall.
- The row always fits: tiles shrink to the space above the prompt, and a row with too many ends with `+N`.
- Sending the prompt, or deleting the tags, clears the row.

When Claude opens an image with the `Read` tool, a thumbnail is drawn under that row, up to 7 rows by 32 columns, and stays in the transcript. Under it, the file name (`↗ shot.png`) opens the full image in the system's default viewer when clicked: the file Claude read while it is there, else the row's thumbnail. A folded run of reads (`Read 3 files`) opens when it holds an image, so each one shows. The thumbnail is made when the row is first drawn, so a file written again later (a render that overwrites its output) leaves earlier rows as they were.

## How it works

Claude Code saves every pasted image as `<tmp>/<project>/<session>/images/<n>.<ext>` and puts an `[Image #n]` tag in the prompt.

1. Every 200 ms the mod reads the prompt and looks for `[Image #n]` tags; pasting raises no edit event.
2. For each tag it finds the cached file. The terminal draws PNG only, so on macOS any other format is converted once with `sips` to `<session>/image-view-<n>.png`. The size comes from the PNG header.
3. Where Claude Code draws real pictures it uses Claude Code's `Image` element, and the terminal reads the file itself.
4. Anywhere else the mod decodes the PNG, averages it down and draws it in colored half blocks (`▀`) with the `Raster` element.
5. For a `Read` of an image file it redraws the tool's row with the picture under it. On macOS a thumbnail is made once per read with `sips` as `<tmp>/image-view-read-<session>-<call>.png`, at most 480 pixels on its longest side; without `sips` a PNG is drawn from the file itself and other formats are not drawn.

## Terminal support

Claude Code decides whether a terminal gets real pictures, by the terminal's name: kitty (0.28+) and Ghostty, never inside tmux or screen or in a background session. The mod mirrors that rule:

| Terminal | Thumbnail |
| --- | --- |
| Ghostty, kitty | Real picture |
| A terminal running inside Ghostty or kitty that sets its own `TERM_PROGRAM` (Herdr, VS Code) | Half blocks |
| iTerm2, Terminal.app, WezTerm, Windows Terminal and most others | Half blocks |
| Inside tmux or screen | Half blocks |
| Background sessions | Half blocks, or real pictures with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` |

Herdr with `kitty_graphics` turned on draws real pictures, but Claude Code does not trust it by name: set `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` (below) to get them there.

`CLAUDE_IMAGE_VIEW_RENDERER` overrides the guess: `image` for real pictures, `blocks` for half blocks. `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` makes Claude Code draw pictures in any terminal; set it only where the terminal supports the kitty protocol's Unicode placeholders.

## What it reads, runs and writes

Local only, no network requests. It reads the prompt box, lists Claude Code's temp folder to find the session's image cache, and reads each pasted image (up to Claude Code's 4 MiB read limit). For each image Claude reads it reads that file and, on macOS, writes one small PNG thumbnail into Claude Code's temp folder. It runs `id -u` once on macOS and Linux to find that folder, `sips` for a non-PNG paste and for each read image on macOS, and `open` (`xdg-open` on Linux) when you click a read image's file name. It reads a few terminal variables (`TERM`, `TERM_PROGRAM`, `TMUX`, `GHOSTTY_RESOURCES_DIR` and similar) to choose the thumbnail kind. `claude plugin validate plugins/image-view` lists every event it hooks and call it makes.

## Requirements

- Claude Code v2.1.287 or later.
- macOS or Linux. Windows finds pastes too but previews only PNG pastes, and Linux previews only PNG pastes (no `sips`).
- Ghostty or kitty for full-resolution thumbnails; any other terminal gets half blocks, best with truecolor.

The Claude desktop app previews pasted images itself, so the mod draws nothing there.

## Troubleshooting

- Nothing appears: check that `/plugin` lists `image-view` as an active mod, then run `/reload-plugins`.
- A tile says "no preview": the cached file was not found, or the paste is not a PNG and you are not on macOS.
- A tile shows `[Image #1]` text instead of the picture: Claude Code did not draw the picture the mod expected. Set `CLAUDE_IMAGE_VIEW_RENDERER=blocks` where you start Claude Code.
- A tile is a grid of colored squares: `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` is set in a terminal without Unicode placeholders. Unset it.

## Tests

`claude plugin test plugins/image-view` runs the layout, PNG decoding and renderer choice, the band against a fake host (a paste found in the temp folder, conversion, the half-block path, the `+N` row) and the transcript rows (a read image drawn from its thumbnail or in half blocks, its file name opening it, rows left alone, a folded run opened). They do not prove what a given terminal draws; that needs a paste or a read in that terminal.
