# Verification

How each plugin is checked and what that does not prove. Run the commands to get current counts; they change with every test added.

```
claude plugin validate .
claude plugin test plugins/branch-guard
claude plugin test plugins/chatgpt
claude plugin test plugins/codex-computer-use
claude plugin test plugins/tailscale
claude plugin test plugins/hud
claude plugin test plugins/flightdeck
claude plugin test plugins/pantheon
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs
```

## What the tests cover

| Plugin | Tests | Host |
| --- | --- | --- |
| branch-guard | Classification of commands, protected-branch detection, the held band and its buttons | A fake host that answers by executable and subcommand |
| chatgpt | Page scripts' flow, tab handling, queue, jobs, attachments | A fake `Browser`; no real page |
| codex-computer-use (plugin) | Command parsing, routing, the approval band, `limitMs` | The `claude-code/testing` host |
| codex-computer-use (helper) | Hub, MCP client, approvals, owners, `install.sh --check` | The real hub and client against a fake MCP server, with approvals pointed at a temp file |
| tailscale | URL building, the forbidden call, redaction, `ETag`/`If-Match` | A fake `fetch`; no fake host |
| hud | The line on terminal and desktop, pace marks, cache states and prices, narrow-terminal steps, settings | The `claude-code/testing` host; no real session, so the paint is not checked |
| flightdeck | Reducers and formatters, panels mounted on every surface at 40–120 columns, cards and swimlanes, the gate drill-down with redaction, settings | The `claude-code/testing` host; no real session |
| pantheon | Config merge and validation, role and sandbox resolution, `cwd` confinement, codex argv and JSONL parsing, job lifecycle (foreground, background, cancel, resume), prompts and Council Mode triggers, the pane on terminal and desktop, the commands | The `claude-code/testing` host with fake `process.spawn`, `process.run`, `fs` and clock; no real Codex |

## What they do not prove

- No end-to-end run on a real desktop: Codex's computer-use runtime is not in this repository, so the app-control path is tested only against a fake server.
- chatgpt's selectors follow chatgpt.com as of 2026-10. When the UI changes, `/chatgpt-doctor` finds the break; the tests will not.
- pantheon's tests never start Codex: the argv, the JSONL parser and the job lifecycle run against a fake `process.spawn` fed with a recorded `codex exec --json` sample. A live run (explorer, fixer, resume into the background, cancel, a council with one seat per engine, the oracle, `/pantheon`) was checked by hand in a real session; a Codex CLI that changes its JSONL events can break it without a test failing here.
- The plugins use the function hooks API, in early access, so a Claude Code update can break them without a test failing here.
- `branch-guard` reads command text. Aliases, scripts and anything the text does not show get past it (commands inside `$(…)` and `bash -c` are classified); it is a safety net, not a permission system.
