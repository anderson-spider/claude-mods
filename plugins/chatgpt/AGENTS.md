# chatgpt

Setup, use, privacy or live browser checks: read [README.md](README.md). Editing backend choice or registration: read `tests/backends.test.ts` and `tests/register.test.ts` for the pinned behavior. Editing prompts: `tests/prompts.test.ts` pins the send boundaries, character budget and image boundaries. A new page script gets its fake branch in `tests/fake-page.ts` (`scriptKind`, `fakePage`).

- `scripts.ts`: page scripts/selectors; `terminal-browser.ts`, `chrome-browser.ts`, `builtin-browser.ts`: injected `Browser` adapters; the MCP adapters share `mcp-browser.ts` (calls/upload/polling); `browsers.ts`: chooser.
- `backends.ts`: the single `BACKENDS` list (the order the plugin tries them), `OWN_CALLS` and the pure `ownCallAllowed`: what `tool.check` allows, only the plugin's own browser calls on chatgpt.com, never the model's. A new backend gets its row in `tests/backends.test.ts`, which pins the allow and deny cases over the real list.
- `register.tsx`: MCP calls, named `$.tool.register`/`$.command.register` calls, and the literal `on('tool.check', ...)` that passes the call's origin, tool, input and the plugin's tab to `ownCallAllowed` (`tests/register.test.ts` pins that wiring). `backends.ts` takes no `$`.
- `tool-schemas.ts`: schemas/jobs/commands; `prompts.ts`: ask/image descriptions and prompt section; `ask.ts`, `image.ts`, `conversation.ts`: flows; `runner.ts`: queue/jobs; `output.ts`: `$TMPDIR/chatgpt/` files.

Checks: `claude plugin validate plugins/chatgpt`; `claude plugin test plugins/chatgpt`; `node scripts/check-consistency.mjs`.
