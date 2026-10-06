# Verification

How each plugin is checked and what that does not prove. Run the commands to get current counts; they change with every test added.

```
claude plugin validate .
claude plugin test plugins/blast-radius
claude plugin test plugins/branch-guard
claude plugin test plugins/chatgpt
claude plugin test plugins/codex-computer-use
claude plugin test plugins/tailscale
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

## What they do not prove

- No end-to-end run on a real desktop: Codex's computer-use runtime is not in this repository, so the app-control path is tested only against a fake server.
- chatgpt's selectors follow chatgpt.com as of 2026-10. When the UI changes, `/chatgpt-doctor` finds the break; the tests will not.
- The plugins use the function hooks API, in early access, so a Claude Code update can break them without a test failing here.
- `blast-radius` and `branch-guard` read command text. `$(…)`, aliases and scripts get past them; they are a safety net, not a permission system.
