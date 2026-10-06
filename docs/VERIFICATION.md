# Verification

How each plugin is checked and what that does not prove. Run the commands to get current counts; they change with every test added.

```
claude plugin validate .
claude plugin test plugins/blast-radius
claude plugin test plugins/branch-guard
claude plugin test plugins/chatgpt
claude plugin test plugins/codex-computer-use
claude plugin test plugins/tailscale
claude plugin test plugins/threads
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/helper.test.mjs
```

## What the tests cover

| Plugin | Tests | Host |
| --- | --- | --- |
| blast-radius, branch-guard | Classification of commands, protected-branch detection, the held band and its buttons | A fake host that answers by executable and subcommand |
| chatgpt | Page scripts' flow, tab handling, queue, jobs, attachments | A fake `Browser`; no real page |
| codex-computer-use (plugin) | Command parsing, routing, the approval band, `limitMs` | The `claude-code/testing` host |
| codex-computer-use (helper) | Hub, MCP client, approvals, owners, `install.sh --check` | The real hub and client against a fake MCP server, with approvals pointed at a temp file |
| tailscale | URL building, the forbidden call, redaction, `ETag`/`If-Match` | A fake `fetch`; no fake host |

threads is covered by one suite (`tests/threads.test.ts`) over a fake `Probe` that answers `git` and `herdr` by command line and keeps the registry in memory: the CLI wrapper, worktree classification, the transcript reader, the registry and state machine, `start`, `status`, `answer`, `close`, polling and announcements, and the registration of the tools and command.

## What they do not prove

- No end-to-end run on a real desktop: Codex's computer-use runtime is not in this repository, so the app-control path is tested only against a fake server.
- chatgpt's selectors follow chatgpt.com as of 2026-10. When the UI changes, `/chatgpt-doctor` finds the break; the tests will not.
- The plugins use the function hooks API, in early access, so a Claude Code update can break them without a test failing here.
- threads is not run against a real Herdr, Claude Code or Codex. Acceptance by hand, in a Herdr pane: `threads_start` in a Herdr main checkout (the toast and the new pane appear); a helper that commits finishes and the chat gets its answer; a helper that runs an unapproved Bash stops as blocked and is announced once, and `threads_answer` with `["1","enter"]` unblocks it; `threads_close` on a helper with commits keeps its worktree and branch, and on a helper that changed nothing removes both; `/threads attach <id>` focuses the pane. The announcement path (`$.prompt.submit`) and a real polling tick are only exercised by that run.
- `blast-radius` and `branch-guard` read command text. `$(…)`, aliases and scripts get past them; they are a safety net, not a permission system.
