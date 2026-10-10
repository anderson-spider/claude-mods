# Verification

How each plugin is checked and what that does not prove. Run the commands to get current counts; they change with every test added.

```
claude plugin validate .
claude plugin test plugins/branch-guard
claude plugin test plugins/chatgpt
claude plugin test plugins/codex-computer-use
claude plugin test plugins/tailscale
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
| pantheon | Config and sandbox rules, including rejection of the old `fixer` name in top-level/profile `agents` and `disabledAgents` with migration messages naming `executor`, `cwd` confinement, Codex argv and JSONL parsing, job lifecycle, prompts and Council Mode; native and session reducers, redaction, rounds, reload recovery and state normalization; eight fixed role slots and other agents; the agents view in docked, inline mini and desktop layouts, the SVG timeline, the session log, the Cancel action, rails, pulse and clocks; tracking hook pass-through, queued writes and failure warnings, auto-open and close; the above-prompt strip (the box rows at 120, 80 and 50 columns with every row the same width in terminal cells, 5h and 7d rows aligned, pace marks and the projection including the burning case, cache states, the last-turn receipt counters fed by the register hooks with every handler passing events through unchanged, the agents folded into the last row, narrow-terminal steps) | Pure-module tests and the `claude-code/testing` host with fake `process.spawn`, `process.run`, `fs` and clock; no real Codex |

## What they do not prove

- No end-to-end run on a real desktop: Codex's computer-use runtime is not in this repository, so the app-control path is tested only against a fake server.
- chatgpt's selectors follow chatgpt.com as of 2026-10. When the UI changes, `/chatgpt-doctor` finds the break; the tests will not.
- pantheon's tests never start Codex: the argv, the JSONL parser and the job lifecycle run against a fake `process.spawn` fed with a recorded `codex exec --json` sample. Before the role rename, a live run (explorer, the implementation role now named executor, resume into the background, cancel, a council with one seat per engine, the oracle, `/pantheon`) was checked by hand in a real session; a Codex CLI that changes its JSONL events can break it without a test failing here.
- The terminal pane has been verified live. The desktop surface and the Codex rows (job id, Cancel button) are still covered only by tests; they need a real app session with explorer and oracle running in parallel to check rendering, motion and live tracking. Mounted tests do not establish visual acceptance.
- The plugins use the function hooks API, in early access, so a Claude Code update can break them without a test failing here.
- `branch-guard` reads command text. Aliases, scripts and anything the text does not show get past it (commands inside `$(…)` and `bash -c` are classified); it is a safety net, not a permission system.
