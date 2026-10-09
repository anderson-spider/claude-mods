# codex-computer-use

Routes native Mac app control through Codex computer use, refusing Claude's own desktop tools while on. `/codex-cu` controls it.

Two halves over a Unix socket:

- The plugin (`hooks/`).
- `helper/`: plain Node ESM run by the ChatGPT app's `node`, installed by `helper/install.sh` as LaunchAgent `com.anderson-spider.codex-cu` into `~/.claude/mcp/codex-cu`.

The helper is the MCP client of Codex's `cua_repl` server and answers its app-approval questions from the person's choices, because the plugin cannot answer an MCP elicitation.

## Helper (`helper/lib/`)

- `hub.mjs`: sessions, ownership, approvals flow.
- `approvals.mjs`: policy.
- `codex-approvals.mjs`: Codex's saved list.
- `config.mjs` and `launch.mjs`: the connection (`launch.mjs` sits in `helper/`).

## Plugin (`hooks/`)

- `bridge.ts` runs the call/approval rounds.
- `routing.ts` and `presentation.ts` are pure text.
- `helper.ts` is the socket link.

## Tests

The helper's tests run with the ChatGPT app's `node`: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs`.
