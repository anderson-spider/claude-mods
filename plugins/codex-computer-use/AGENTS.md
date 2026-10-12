# codex-computer-use

Setup, use, privacy or live desktop checks: read [README.md](README.md). MCP app-approval elicitation belongs to the helper; the plugin cannot answer it.

## Map and safety

- `hooks/register.tsx`: registration/routing; `bridge.ts`: call/approval rounds; `question.ts`: queued question with injected clock/wait/band; `routing.ts`/`presentation.ts`: pure text; `helper.ts`: socket link.
- `helper/helper.mjs`: Unix-socket entry point; `helper/lib/hub.mjs`: sessions/ownership/approvals; `approvals.mjs`: policy; `codex-approvals.mjs`: saved list; `config.mjs` and `helper/launch.mjs`: connection.
- Helper is Node ESM, run by the ChatGPT app's `node`; `helper/install.sh` installs LaunchAgent `com.anderson-spider.codex-cu` in `~/.claude/mcp/codex-cu`.
- Socket `run/helper.sock` and approvals `state/approvals.json` are fixed beside installed `helper.mjs`. Neither installer nor uninstaller edits Claude settings; uninstall retains code/approvals/logs. Install accepts only `--check` or no arguments; uninstall takes none (`helper/test/config.test.mjs`).
- App approvals expire five minutes from **before entering the queue**; clock/poll failure must never approve. Coverage: `tests/question.test.ts`; Claude desktop-tool refusal while on: `tests/register.test.ts`.

## Checks

- `claude plugin validate plugins/codex-computer-use`; `claude plugin test plugins/codex-computer-use`; `node scripts/check-consistency.mjs`.
- `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs`.
- `helper/test/contract.mjs` is shared caller/socket evidence. Host timeout tests inject `clock.now` and release held polls; helper tests use injected fakes or an isolated copied installation, never installed run/state directories.
