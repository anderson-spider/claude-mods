# image-view

Shows the images you paste into Claude Code as thumbnails above the prompt, instead of bare `[Image #1]` tags.

Based on [claude-image-view](https://github.com/jarrodwatts/claude-image-view) by Jarrod Watts, under the MIT license (see [LICENSE](LICENSE)). This copy draws half-block thumbnails in a terminal that runs inside Ghostty or kitty but is not one of them, such as Herdr, where the original shows only the `[Image #n]` text.

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

## How it works

Claude Code saves every pasted image as `<tmp>/<project>/<session>/images/<n>.<ext>` and puts an `[Image #n]` tag in the prompt.

1. Every 200 ms the mod reads the prompt and looks for `[Image #n]` tags; pasting raises no edit event.
2. For each tag it finds the cached file. The terminal draws PNG only, so on macOS any other format is converted once with `sips` to `<session>/image-view-<n>.png`. The size comes from the PNG header.
3. Where Claude Code draws real pictures it uses Claude Code's `Image` element, and the terminal reads the file itself.
4. Anywhere else the mod decodes the PNG, averages it down and draws it in colored half blocks (`▀`) with the `Raster` element.

## Terminal support

Claude Code decides whether a terminal gets real pictures, by the terminal's name: kitty (0.28+) and Ghostty, never inside tmux or screen or in a background session. The mod mirrors that rule:

| Terminal | Thumbnail |
| --- | --- |
| Ghostty, kitty | Real picture |
| A terminal running inside Ghostty or kitty that sets its own `TERM_PROGRAM` (Herdr, VS Code) | Half blocks |
| iTerm2, Terminal.app, WezTerm, Windows Terminal and most others | Half blocks |
| Inside tmux or screen | Half blocks |
| Background sessions | Half blocks, or real pictures with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` |

`CLAUDE_IMAGE_VIEW_RENDERER` overrides the guess: `image` for real pictures, `blocks` for half blocks. `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` makes Claude Code draw pictures in any terminal; set it only where the terminal supports the kitty protocol's Unicode placeholders.

## What it reads, runs and writes

Local only, no network requests. It reads the prompt box, lists Claude Code's temp folder to find the session's image cache, and reads each pasted image (up to Claude Code's 4 MiB read limit). It runs `id -u` once on macOS and Linux to find that folder, and `sips` for a non-PNG paste on macOS, writing one PNG into the session's temp folder. It reads a few terminal variables (`TERM`, `TERM_PROGRAM`, `TMUX`, `GHOSTTY_RESOURCES_DIR` and similar) to choose the thumbnail kind. `claude plugin validate plugins/image-view` lists every event it hooks and call it makes.

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

`claude plugin test plugins/image-view` runs the layout, PNG decoding and renderer choice, and the band against a fake host: a paste found in the temp folder, conversion, the half-block path and the `+N` row. They do not prove what a given terminal draws; that needs a paste in that terminal.
