# Threads

A lead chat creates real Claude Code sessions ("threads") on the models you choose, watches them live and steers them. Each thread is an interactive `claude` in a private tmux server (`tmux -L cc-threads`), so it needs no visible terminal.

Adapted from [promptadvisers/claude-mods-computer-use-threads](https://github.com/promptadvisers/claude-mods-computer-use-threads); see `NOTICE`.

## Requirements

- `tmux`, a signed-in terminal Claude Code (`claude auth login`) and a trusted folder. Run `/threads setup` to check.
- For the Codex link: the `codex-computer-use` plugin with its helper running.

## With codex-computer-use

- The panel shows `desk  drives <App>` for a thread that holds an app lease, read from the helper's `/status`.
- Closing a thread frees its Codex session and apps through the helper's `/release`.
- A thread waiting on the per-app question ("Codex computer use · Allow “App”?") shows as needing you; approving answers it with "This session", denying with "No". "Always" stays a choice you make in the thread itself.

## Permissions

New threads start in the `default` permission mode. Change it with `/threads mode <mode>` or the `defaultPermissionMode` setting; `--mode` sets it per thread.

## Commands

`/threads help` lists them. Tests: `claude plugin test plugins/threads`.
