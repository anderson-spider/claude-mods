# Threads

A lead chat creates real Claude Code sessions ("threads") on the models you choose, watches them live and steers them. Each thread is an interactive `claude` in a private tmux server (`tmux -L cc-threads`), so it needs no visible terminal.

Adapted from [promptadvisers/claude-mods-computer-use-threads](https://github.com/promptadvisers/claude-mods-computer-use-threads); see `NOTICE`.

## Requirements

- `tmux`, a signed-in terminal Claude Code (`claude auth login`) and a trusted folder. Run `/threads setup` to check.
- For the Codex link: the `codex-computer-use` plugin with its helper running.
- For Codex threads: the `codex` CLI on your PATH, signed in (see [Codex threads](#codex-threads)).

## With codex-computer-use

- The panel shows `desk  drives <App>` for a thread that holds an app lease, read from the helper's `/status`.
- Closing a thread frees its Codex session and apps through the helper's `/release`.
- A thread waiting on the per-app question ("Codex computer use · Allow “App”?") shows as needing you; approving answers it with "This session", denying with "No". "Always" stays a choice you make in the thread itself.

## Codex threads

A thread can be a Codex session instead of a Claude one: `/threads new codex Scout --codex -- <task>`, or `backend: "codex"` in `threads_create`. The model is a Codex model name (passed through as is), or `codex` for the account default. It shows in the same panel, with its status, activity, approvals and interrupt, and its answer reaches the lead chat like a Claude thread's report (`--no-report` keeps it quiet).

- How it runs: `helper/helper.mjs` (one per user, plain Node) runs `codex app-server` and serves its routes on `~/.claude/threads-codex/run/helper.sock`. A thread that needs it starts the helper detached; the helper exits with its Codex child, and a second start exits at once. Its log is `~/.claude/threads-codex/state/helper.log`.
- Modes: `default` is read-only with approval on request; `acceptEdits` and `auto` are workspace-write with approval on request; `plan` is read-only with `untrusted` approval. `bypassPermissions` is refused: Codex threads never bypass. A bypass default from the setting falls back to `default` for a Codex thread that names no mode.
- Approvals: Codex asks through the helper, and the request shows in the pane with Approve and Deny (or `/threads approve|deny <id>`). Each one asks you to confirm first; accepting or declining is the only answer the plugin gives. Requests the helper cannot answer (user input, MCP elicitation) are refused.
- Not supported: fork, handoff, worktrees, plan phases, switching model or effort, a cost estimate, and a terminal pane (`/threads open` shows the resume command instead). `--inline` and `--session` cannot be combined with `--codex`, and `--worktree` is refused.
- Closing stops tracking the thread and interrupts a running turn first. The Codex transcript stays: continue it with `codex resume <id>`.
- Limits: the helper keeps the threads in memory. When it restarts, its Codex threads show as exited (with the reason); their transcripts remain in Codex.

## Permissions

New threads start in the `default` permission mode. Change it with `/threads mode <mode>` or the `defaultPermissionMode` setting; `--mode` sets it per thread.

## Commands

`/threads help` lists them. Tests: `claude plugin test plugins/threads`.
