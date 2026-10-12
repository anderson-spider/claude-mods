# Verification

How each plugin is checked and what that does not prove. Run the commands to get current counts; they change with every test added.

```
claude plugin validate .
claude plugin test plugins/branch-guard
claude plugin test plugins/chatgpt
claude plugin test plugins/codex-computer-use
claude plugin test plugins/codex-models
claude plugin test plugins/crew
claude plugin test plugins/tailscale
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs
go -C plugins/codex-models/proxy test -race ./...
node --test plugins/codex-models/tests/scripts/*.test.mjs
```

## What the tests cover

| Plugin | Tests | Host |
| --- | --- | --- |
| branch-guard | Classification of commands, protected-branch detection, the held band and its buttons | A fake host that answers by executable and subcommand |
| chatgpt | Page scripts' flow, tab handling, queue, jobs, attachments | A fake `Browser`; no real page |
| codex-computer-use (plugin) | Command parsing, routing, the approval band, `limitMs` | The `claude-code/testing` host |
| codex-computer-use (helper) | Hub, MCP client, approvals, owners, `install.sh --check` | The real hub and client against a fake MCP server, with approvals pointed at a temp file |
| codex-models (plugin) | The status reply and report, the settings merge and unmerge, the hooks through the test host | Pure modules; a fake `http.fetch` for the hooks |
| codex-models (proxy) | Configuration, listeners, the guard and routes, byte-for-byte pass-through, the streaming translation, OAuth and the credential store, effort, the catalog, compressed bodies | The Go test packages; no network |
| codex-models (installer) | `install.sh` and `uninstall.sh` against a temporary `HOME`, with a fake `launchctl` and `mise` | The real scripts with fakes; no LaunchAgent is loaded |
| crew | Each agent's model and effort, the write lanes, Jev routing (tier, effort, breaker, key, decision log), the Flightdeck dashboard and the `/crew:panel` command | The test host with a fake `http.fetch`; nothing reaches Jev |
| tailscale | URL building, the forbidden call, redaction, `ETag`/`If-Match` | A fake `fetch`; no fake host |

## What they do not prove

- No end-to-end run on a real desktop: Codex's computer-use runtime is not in this repository, so the app-control path is tested only against a fake server.
- chatgpt's selectors follow chatgpt.com as of 2026-10. When the UI changes, `/chatgpt-doctor` finds the break; the tests will not.
- The terminal pane has been verified live. The desktop surface is still covered only by tests; they need a real app session with code-reader and architect running in parallel to check rendering, motion and live tracking. Mounted tests do not establish visual acceptance.
- The plugins use the function hooks API, in early access, so a Claude Code update can break them without a test failing here.
- codex-models: no real ChatGPT login, Codex request or Claude Code session is exercised by the tests; the installer tests never load the LaunchAgent. Whether a new session lists the Codex rows in `/model` and what a `crew:*-codex` agent answers is checked live only.
- `branch-guard` reads command text. Aliases, scripts and anything the text does not show get past it (commands inside `$(…)` and `bash -c` are classified); it is a safety net, not a permission system.
