# chatgpt

Setup, use, privacy or live browser checks: read [README.md](README.md). Editing backend choice or registration: read `tests/register.test.ts` for the pinned behavior. Editing prompts: `tests/prompts.test.ts` pins the send boundaries, character budget and image boundaries. A new page script gets its fake branch in `tests/fake-page.ts` (`scriptKind`, `fakePage`).

- `scripts.ts`: page scripts/selectors; `terminal-browser.ts`, `chrome-browser.ts`, `builtin-browser.ts`: injected `Browser` adapters; the MCP adapters share `mcp-browser.ts` (calls/upload/polling); `browsers.ts`: chooser.
- `register.tsx`: single `BACKENDS` list, MCP calls, named `$.tool.register`/`$.command.register` calls. Its `tool.check` allows only the plugin's own browser calls on chatgpt.com, never the model's (`tests/register.test.ts`).
- `tool-schemas.ts`: schemas/jobs/commands; `prompts.ts`: ask/image descriptions and prompt section; `ask.ts`, `image.ts`, `conversation.ts`: flows; `runner.ts`: queue/jobs; `output.ts`: `$TMPDIR/chatgpt/` files.

Checks: `claude plugin validate plugins/chatgpt`; `claude plugin test plugins/chatgpt`; `node scripts/check-consistency.mjs`.
