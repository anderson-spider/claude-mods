# Verification

How each plugin is checked and what that does not prove. Run the commands to get current counts; they change with every test added.

```
claude plugin validate .
claude plugin test plugins/chatgpt
claude plugin test plugins/codex-computer-use
claude plugin test plugins/codex-models
claude plugin test plugins/crew
claude plugin test plugins/tailscale
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs
go -C plugins/codex-models/proxy test -race ./...
go -C plugins/codex-models/proxy test -race -tags contract ./...
node --test plugins/codex-models/tests/scripts/*.test.mjs
```

## What the tests cover

| Plugin | Tests | Host |
| --- | --- | --- |
| chatgpt | Page scripts' flow, tab handling, queue, jobs, attachments | A fake `Browser`; no real page |
| codex-computer-use (plugin) | Command parsing, routing, the approval band, the fixed five-minute approval deadline | The `claude-code/testing` host; timeout tests control `clock.now` and release held polls without real deadline waits |
| codex-computer-use (helper) | Hub, MCP client, approvals, owners, `install.sh --check`, installer and uninstaller argument validation | Fake dependencies or a helper copied into a temporary installation layout; the real hub and client against a fake MCP server; no writes to installed run/state directories |
| codex-models (plugin) | The status reply and report, the settings merge and unmerge, the hooks through the test host | Pure modules; a fake `http.fetch` for the hooks |
| codex-models (proxy) | Configuration, listeners, the guard and routes, byte-for-byte pass-through, the streaming translation, OAuth and the credential store, effort, the catalog, compressed bodies, the Codex rate-limit windows in the status | The Go test packages; no network |
| codex-models (proxy, contract) | The binary as a client sees it: the guard, pass-through, the Codex translation, native login and the credential lock, log privacy, the status and `codexLimits`, shutdown and the command line | A black-box suite that builds the proxy with `-tags contract` and runs it against local fakes of Anthropic, Codex and the token endpoint; no network |
| codex-models (installer) | Reinstall idempotence, precheck/preflight ordering, foreign settings refusal, current-key uninstall, retained installed files, private atomic writes/backups and symlinks, concurrent changes, write failures keeping the service loaded, inert unreferenced files, unsupported flags and secret masking | The real scripts against a temporary `HOME`, with fake `launchctl`, `mise` and proxy; no LaunchAgent is loaded |
| crew | See [crew verification](../plugins/crew/README.md#verification) for coverage and live gaps | Test host with fake network access |
| tailscale | URL building, the forbidden call, redaction, `ETag`/`If-Match` | A fake `fetch`; no fake host |

## What they do not prove

- No end-to-end run on a real desktop: Codex's computer-use runtime is not in this repository, so the app-control path is tested only against a fake server.
- chatgpt's selectors follow chatgpt.com as of 2026-10. When the UI changes, `/chatgpt-doctor` finds the break; the tests will not.
- Crew: see [verification and live gaps](../plugins/crew/README.md#verification).
- The plugins use the function hooks API, in early access, so a Claude Code update can break them without a test failing here.
- codex-models: no real ChatGPT login, Codex request or Claude Code session is exercised by the tests; the installer tests never load the LaunchAgent. Whether a new session lists the Codex rows in `/model` and what a `crew:*-codex` agent answers is checked live only. The `wham/usage` field names come from a third-party report, and a real `?refresh=limits` against OpenAI (and the status during a real token refresh) has not been run.
