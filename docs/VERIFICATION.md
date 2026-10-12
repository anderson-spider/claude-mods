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
| codex-models (proxy, contract) | The binary as a client sees it: the guard, pass-through, the Codex translation, login and locks, log privacy, the status and `codexLimits`, shutdown and the command line | A black-box suite that builds the proxy with `-tags contract` and runs it against local fakes of Anthropic, Codex and the token endpoint; no network |
| codex-models (installer) | `install.sh` and `uninstall.sh` against a temporary `HOME`, with a fake `launchctl` and `mise` | The real scripts with fakes; no LaunchAgent is loaded |
| crew | Each agent's model and effort, the write lanes, Jev routing (tier, effort, breaker, key, decision log), quota-aware routing (the status read, the provider decision, the type rewrite), the HUD (its state, drawing, active plan) and the `/crew:panel` command | The test host with a fake `http.fetch`; nothing reaches Jev |
| tailscale | URL building, the forbidden call, redaction, `ETag`/`If-Match` | A fake `fetch`; no fake host |

## What they do not prove

- No end-to-end run on a real desktop: Codex's computer-use runtime is not in this repository, so the app-control path is tested only against a fake server.
- chatgpt's selectors follow chatgpt.com as of 2026-10. When the UI changes, `/chatgpt-doctor` finds the break; the tests will not.
- The crew HUD was checked live in the terminal: the docked and the inline pane, `/crew:panel` and its saved pick, the Session, Quota, Plan, agent, Review, timeline and Log cards, the Waiting on you row on a real Bash dialog and an MCP tool's dialog (and its absence in `auto` mode), a narrow docked pane, and agent timing by job (one end line per job, a background wake kept in its job, a resume through `SendMessage` opening a new one). Quota routing's switch to a `-codex` twin was checked live against a local fake Codex, not a real account: the type rewrite, the tag and confirmation, the decision record, the Quota card, routing off, a Codex reading too high to switch, and no key or token in the logs and records. Still unverified live: the pane's close mark, the Agent tool's ask, the advisor tool's block, the notice of a switched or background spawn, the full layout at 56 columns (the host's kept dock width won in every run), the `×N` job counts, the Quota heading's stale and down words, a name as a `SendMessage` target, a refused or throwing `SendMessage` (covered by host tests), the Codex 5-hour veto and the stale-reading rule, and a real Codex twin's tool use. The desktop surface is covered only by mounted tests, which do not establish visual acceptance.
- The plugins use the function hooks API, in early access, so a Claude Code update can break them without a test failing here.
- codex-models: no real ChatGPT login, Codex request or Claude Code session is exercised by the tests; the installer tests never load the LaunchAgent. Whether a new session lists the Codex rows in `/model` and what a `crew:*-codex` agent answers is checked live only. The `wham/usage` field names come from a third-party report, and a real `?refresh=limits` against OpenAI (and the status during a real token refresh) has not been run.
