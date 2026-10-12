# codex-computer-use

Routes native Mac app control through Codex computer use, refusing Claude's own desktop tools while on. `/codex-cu` controls it.

Two halves over a Unix socket:

- The plugin (`hooks/`).
- `helper/`: plain Node ESM run by the ChatGPT app's `node`, installed by `helper/install.sh` as LaunchAgent `com.anderson-spider.codex-cu` into `~/.claude/mcp/codex-cu`.

The helper stores its socket in `run/helper.sock` and its approvals in `state/approvals.json`, both beside the installed `helper.mjs`. These directories are fixed. Install accepts only `--check` or no arguments; uninstall accepts no arguments and retains code, approvals and logs. Neither script edits Claude settings.

The helper is the MCP client of Codex's `cua_repl` server and answers its app-approval questions from the person's choices, because the plugin cannot answer an MCP elicitation.

## Helper (`helper/lib/`)

- `helper.mjs` (in `helper/`): the entry point the LaunchAgent runs; serves the plugin over the Unix socket.
- `hub.mjs`: sessions, ownership, approvals flow.
- `approvals.mjs`: policy.
- `codex-approvals.mjs`: Codex's saved list.
- `config.mjs` and `launch.mjs`: the connection (`launch.mjs` sits in `helper/`).

## Plugin (`hooks/`)

- `bridge.ts` runs the call/approval rounds.
- `question.ts` holds one approval question at a time; the clock, the wait and the band are injected.
- `routing.ts` and `presentation.ts` are pure text.
- `helper.ts` is the socket link.

App approvals have a fixed five-minute deadline, counted from before a question enters the queue. The host clock is injected into the pure question flow; a clock or polling failure never approves an app.

## Tests

Host timeout tests control `clock.now` and release held polls without real deadline waits. Helper tests inject fake dependencies or copy the helper into a temporary installation layout; they never write to installed run/state directories.

`helper/test/contract.mjs` holds the caller and socket examples that both the plugin's tests and the helper's tests check. The helper's tests run with the ChatGPT app's `node`: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs`.
