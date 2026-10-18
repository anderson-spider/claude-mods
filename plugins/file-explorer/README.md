# file-explorer

A file tree pane beside the conversation, like an editor's sidebar. It shows the session's folder with git status, marks each file Claude reads, edits, creates, removes, finds or commits as it happens, and lets you search, preview a file or put `@path` in the prompt without leaving the session.

```text
/plugin install file-explorer@spider-claude-mods
```

The functional reference was [claude-code-filetree](https://github.com/data-goblin/claude-code-filetree) by Kurt Buhler (MIT). This mod is its own implementation: no code, structure or assets come from it.

## What you see

```text
▾ claude-mods ⎇ main ↑1 2 changed      up · last file · collapse · dotfiles
/ search files
  ▾ plugins/                          2M
    ▸ chatgpt/
●   ▾ file-explorer/                  2M
●     ◇ register.tsx           +12 -3 M        now
      ◇ view.ts                 +2 -0 M         3m
• ▸ scripts/
  ≡ README.md                            yesterday
● edited plugins/file-explorer/hooks/register.tsx 3s
● read README.md 1m
j: ↓ k: ↑ h: ← l: → o: open s: find a: @ref r: ↻
```

- **Header**: the folder, its branch, how far ahead (`↑`) and behind (`↓`) its upstream it is (or `(no upstream)`), how many files changed and the lines added and removed. Outside a repository there is no branch line. At the right, buttons: `up` opens the folder above (pinned, as `/file-explorer <folder>`; `/file-explorer <folder>` goes back), `last file` opens the tree to the last file Claude touched, `collapse` closes every folder, and `dotfiles` shows or hides them (drawn full while shown). The pane's frame has its own close control. A pane too narrow for them leaves them out.
- **Rows**: folders first, then files, sorted by name (or extension, or newest first). Dotfiles are hidden until you press `.`. Folders named in the ignore list (`node_modules`, `dist`, `.venv`...) are drawn dim and left out of search.
- **Modified**: at the right edge of each file, how long ago it was modified: `now`, `3m`, `2h`, `yesterday`, `4d`, `3w`, `5mo`, `2y` (yesterday is 24 to 48 hours ago). In a narrow pane it goes before the git columns do; `mtime: false` hides it.
- **Git**: a file shows its letter (`M` modified, `A` added, `D` deleted, `R` renamed, `?` untracked, `U` conflicted) and, for tracked changes, `+added -removed`. A folder shows how many changed files lie under it, in the colour of the strongest change.
- **Claude's activity**: a dot in the first column, coloured by what Claude did: read, found by Grep or Glob, edited, created, removed, or part of the commit it just made. For about 2.7 seconds after each touch a light runs across the name in that colour, and the dot stays for two minutes. A Write, Edit, MultiEdit or NotebookEdit shows already while it runs: the file carries the edited dot and shimmers, and the tree opens to it when following. With the fixed `dark` and `light` themes the light is a gradient of the colour; with `auto`, whose colours a mod cannot read, it goes from dim to bold in the one colour. A collapsed folder with a touched file somewhere inside shows a dim `•`. The last two touches are listed in the footer.
- **Follow**: when Claude reads, edits or creates a file, the tree opens down to it and the cursor moves there. Searches do not move the tree.

## Open it

In the terminal, the pane docks beside the transcript in the fullscreen layout (`/tui fullscreen`). Claude Code opens it at session start when the terminal is at least 144 columns wide, and seats it from 110 columns once you have opened it yourself. The desktop app docks panes too and runs the same rows module.

| Command | Does |
| --- | --- |
| `/file-explorer` | Opens the pane and gives it the keyboard. |
| `/file-explorer <folder>` | Pins the tree to that folder; a `cd` no longer moves it. |
| `/file-explorer refresh` | Reads the shown folders and git again. |
| `/file-explorer hidden` | Shows or hides dotfiles. |
| `/file-explorer close` | Closes the pane. |

## Keys

Click a row once to give the tree the keyboard, or open the pane with `/file-explorer`. Escape gives the keyboard back to the prompt.

| Key | Action |
| --- | --- |
| `j` / `↓`, `k` / `↑` | Next or previous row |
| `l` / `→` | Open a folder (on an open one, go to its first row) |
| `h` / `←` | Close a folder, or go to the folder above |
| `Enter` / `o` | Open or close a folder; preview a file (or open it in the editor, see `enterAction`) |
| `Space` | Preview a file |
| `e` | Open the file in the editor |
| `a` | Put `@path` at the prompt's cursor |
| `y` | Copy the relative path |
| `/` (or `s` in the footer) | Search |
| `.` | Show or hide dotfiles |
| `r` | Refresh |
| `g` / `G`, `PgUp` / `PgDn` | First or last row, a page up or down |
| `q` | Back from a preview or a search |

With the mouse: a click selects a row and opens or closes a folder, a double click opens a file, and the wheel scrolls the tree. The footer buttons (`j: ↓`, `o: open`...) are the same keys and work whenever the pane holds the keyboard.

## Search

`/` (or `s`) moves to the search field. Results update as you type and cover every file of the project, including folders you never opened: in a git repository from `git ls-files` (tracked and untracked files, `.gitignore` honoured); elsewhere from a walk eight folders deep that skips ignored names and links. The index is built the first time you search and dropped when files are created or removed. Matching is fuzzy by default (the letters in order); `search: substring` needs them together. Enter in the field opens the tree at the best hit; on a hit in the list, Enter or `l` does the same.

## Preview and editor

Space (or Enter, by default) previews a file in the pane: Markdown is drawn, code is highlighted, the arrows scroll, `q` goes back and `e` opens it in the editor. Files over 512 KB and binary files are not previewed, and a preview stops at 2,000 lines.

`e` runs the `editor` command without a shell, so a file name is one argument to the program: `{path}`, `{dir}` and `{line}` are filled in, and the path is appended when the command names none (`code -g {path}:{line}`, `zed`, `subl`, `idea`). A command whose program reads its arguments as a command line (a shell such as `sh -c`, `tmux`, `ssh`, `env`, `cmd`, `powershell`) is refused, because a crafted file name would run as code there. With no command set, the system's default app opens the file (`open` on macOS, `xdg-open` on Linux, `explorer` on Windows), except files that app would run rather than show (`.app`, `.command`, `.jar`, `.exe`, `.bat`, `.desktop` and the like). A terminal editor such as `vim` cannot run this way: there is no terminal to draw in.

## Context for Claude

The explorer never adds anything to Claude's context by itself. `a` writes `@path` (quoted when it holds a space) at the prompt's cursor, unless the draft already has it, and Claude Code attaches the file when you send the prompt, as with a mention you type. When you mention a file with `@path` yourself, the tree opens to it. Nothing of a file is read for the prompt, and the preview's text stays in the pane.

## Settings

Change them in `/config` (they appear under the plugin) or in `settings.json`:

```json
{
  "pluginConfigs": {
    "file-explorer@spider-claude-mods": {
      "options": {
        "autoOpen": true,
        "follow": true,
        "animations": true,
        "showHidden": false,
        "mtime": true,
        "ignore": ".git,node_modules,dist,build,target,.next,.venv,__pycache__,coverage",
        "sort": "name",
        "enterAction": "preview",
        "editor": "code -g {path}:{line}",
        "icons": "unicode",
        "theme": "auto",
        "git": "full",
        "search": "fuzzy",
        "refreshSeconds": 5
      }
    }
  }
}
```

| Option | Default | Values |
| --- | --- | --- |
| `autoOpen` | `true` | Open the pane at session start (where the terminal has room). |
| `follow` | `true` | Open the tree to the files Claude reads, edits and creates. |
| `animations` | `true` | Shimmer a touched name for a moment, and one being written while it runs; `false` keeps only the dot. |
| `showHidden` | `false` | Start with dotfiles shown. |
| `mtime` | `true` | Show how long ago each file was modified. |
| `ignore` | see above | Comma-separated names drawn dim and left out of search. |
| `sort` | `name` | `name`, `type` (extension) or `modified` (newest first); folders always first. |
| `enterAction` | `preview` | `preview` or `editor`: what Enter and a double click do on a file. |
| `editor` | empty | A command with `{path}`, `{dir}`, `{line}`; empty opens the default app. |
| `icons` | `unicode` | `nerd` for Nerd Font glyphs in the terminal (needs a patched font), `unicode` otherwise. The desktop app and other surfaces draw with their own font and always get `unicode`. |
| `theme` | `auto` | `auto` follows the Claude Code theme; `dark` and `light` are fixed palettes. |
| `git` | `full` | `full` (letters and lines), `status` (letters only) or `off`. |
| `search` | `fuzzy` | `fuzzy` or `substring`. |
| `refreshSeconds` | `5` | While the pane is open, how often the shown folders are checked for changes made outside Claude; `0` turns it off. |

A value outside its choices reads as the default.

## How it stays light

- It is local code, not an agent: it makes no model call, adds nothing to the conversation and sends nothing anywhere.
- Only the root and the folders you open are listed, at most 2,000 entries each (a `… N more` row stands for the rest), and the tree draws only the rows in view.
- After each finished tool call it reads the call's input and result. A call that may change files (Write, Edit, MultiEdit, NotebookEdit, Bash) also re-reads the shown folders whose modification time moved, then runs git once, 300 ms after the last change. Refused or failed calls are ignored.
- Git runs by argument list with no shell: `status --porcelain` and, in `full` mode, `diff --numstat HEAD`. It runs with `--no-optional-locks`, so it never holds `.git/index.lock` against Claude's own `git add` or `commit`, and with `core.fsmonitor` off and no external diff or textconv, so a repository's config cannot make it run a command. It runs again when `.git/index` or `.git/HEAD` changes (Claude Code's file watcher), so a commit or checkout made in another terminal shows too.
- Changes made outside Claude to files in open folders are picked up by a check of those folders' modification times every `refreshSeconds` while the pane is open. Claude Code gives a mod no folder watcher, and this is the cheapest check that works on every platform.
- The shimmer runs in the rows' own drawing module on the surface's frame clock, and draws a frame only while a row shimmers; no hook runs per frame. The modified ages are drawn again once a minute while the pane is open.
- Timers stop when the session ends; a `/clear` keeps them, since the process goes on.

Measured by `tests/performance.test.ts` on a development laptop: about 13 ms to lay out 20,000 open rows, 11 ms to rank 50,000 paths, 19 ms to read a git status of 20,000 files, about 2 ms of observation per tool call, and 10 ms from a key to a redrawn 2,000-row folder.

## Limits

- **Where it draws**: the terminal in the fullscreen layout, and the desktop app. In VS Code and on mobile, Claude Code draws no keyboard-driven region for a mod: the rows are plain text there, and the footer buttons move the cursor.
- **Managed settings**: where an organization manages Claude Code, the events for git's own files and for `cd` (`SessionStart`, `FileChanged`, `CwdChanged`) only reach plugins the organization lists. The tree and git still update after Claude's tool calls and on `r`, but a commit made in another terminal shows only after the next refresh, and a `cd` does not move the tree.
- **Shell commands**: a Bash command's effects are read from its words (`rm`, `mv`, `cp`, `touch`, `mkdir`, `git commit`), so a script that writes files is seen only through the folder refresh and git, not as a mark.
- **Windows**: paths with a drive letter are handled and the default opener is `explorer`, but the mod has not been run on Windows.
- **tmux and SSH**: the pane is drawn by Claude Code itself, so it works wherever the fullscreen layout does. Mouse clicks need a terminal (and tmux `mouse on`) that reports them.

## Tests

Pure logic tests call the modules under `hooks/` directly; `tests/register.test.ts` runs the mod against a fake host (`tests/host.ts`) with an in-memory file system and a scripted git. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
