# codex-computer-use

Setup, use, privacy or live desktop checks: read [README.md](README.md). MCP app-approval elicitation belongs to the helper; the plugin cannot answer it.

## Map and safety

- `hooks/register.tsx`: registration/routing; `bridge.ts`: call/approval rounds; `question.ts`: queued question with injected clock/wait/band; `routing.ts`/`presentation.ts`: pure text; `prompts.ts`: prompt, tool schema and help; `helper.ts`: socket link; `model.ts`: wire types.
- `helper/helper.mjs`: Unix-socket entry point, one `ROUTE_TABLE` entry per route (`helper/test/routes.test.mjs` pins the check order and every status and body); `helper/lib/hub.mjs`: sessions/ownership/approvals; `approvals.mjs`: policy; `codex-approvals.mjs`: saved list; `apps.mjs`: app names and bundle ids; `owners.mjs`: per-app holder; `mcp-client.mjs`: stdio MCP client; `version.mjs`: helper version; `config.mjs` and `helper/launch.mjs`: connection.
- Helper is Node ESM, run by the ChatGPT app's `node`; `helper/install.sh` installs LaunchAgent `com.anderson-spider.codex-cu` in `~/.claude/mcp/codex-cu`.
- Socket `run/helper.sock` and approvals `state/approvals.json` are fixed beside installed `helper.mjs`. Neither installer nor uninstaller edits Claude settings; uninstall retains code/approvals/logs. Install accepts only `--check` or no arguments; uninstall takes none (`helper/test/config.test.mjs`).
- Shared contract: routes, choices, reply key sets (`replies`), lease and LaunchAgent label are written once per side and pinned by `helper/test/contract.mjs`, which both test halves compare (`tests/contract.test.ts`, `helper/test/contract.test.mjs`); hooks never import helper modules at runtime. Update together: `contract.mjs`; `hooks/model.ts` (`ROUTES`, `CHOICES`, `RouteReplies`, the only reply-shape source), `routing.ts` (`LEASE_MINUTES`), `helper.ts` (`LABEL`); `helper.mjs` (`ROUTES` and its `ROUTE_TABLE` entry), `lib/approvals.mjs` (`CHOICES`), `lib/hub.mjs` (`LEASE_MS` and the reply keys); `install.sh` and `uninstall.sh` (`LABEL=`). The tool input is typed in `types/index.d.ts`; its keys match `prompts.ts` `INPUT_SCHEMA` at compile time, and the `tool.call` matcher in `register.tsx` is the literal tool name (equal to `routing.ts` `TOOL`).
- Bump `helper/lib/version.mjs` when helper behavior changes; users rerun `install.sh` to load it.
- App approvals expire five minutes from **before entering the queue**; clock/poll failure must never approve. Coverage: `tests/question.test.ts`; Claude desktop-tool refusal while on: `tests/register.test.ts`.

## Checks

- `claude plugin validate plugins/codex-computer-use`; `claude plugin test plugins/codex-computer-use`; `node scripts/check-consistency.mjs`.
- `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs`.
- `helper/test/contract.mjs` is the shared caller, socket, route, choice, lease and label evidence. Host timeout tests inject `clock.now` and release held polls; helper tests use injected fakes or an isolated copied installation, never installed run/state directories.
