# branch-guard

Holds a commit or push on a protected branch until the person proceeds or cancels (a band above the prompt). It is a safety net that reads text, not a permission system.

## Modules

- `classify.ts` reads the Bash text.
- `measure.ts` decides asynchronously whether the target is protected and what would go in, through an injected `Probe`.
- `shell.ts` parses shell text.
- `register.tsx` holds the call.

## Parsing rules

- A heredoc or here-string body is data, except when it is fed to a shell (`bash`, `sh`, `zsh`, `dash`, `ksh`, also through `sudo`/`env`/`ssh`, or by a pipe) with no `-c` or script, where it is parsed as commands.
- The commands inside `$(…)`, backticks and `<(…)`/`>(…)` (also in double quotes and in an unquoted-delimiter heredoc body) are classified as if run on their own.
- `$((…))` and single-quoted text are not classified.

## Tests

IMPORTANT: the test fake host (`answer`) responds by executable and subcommand. A new git command the plugin measures needs an answer there.
