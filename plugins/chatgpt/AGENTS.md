# chatgpt

`ask` and `image` tools, `jobs`, and `/chatgpt-ask`, `/chatgpt-image`, `/chatgpt-doctor`, driving chatgpt.com in the first browser that works:

1. terminal-browser (Claude Code directly in a Ghostty or kitty pane),
2. Claude in Chrome (`mcp__claude-in-chrome__*`),
3. the Claude app's built-in browser (`mcp__Claude_Browser__*`).

## Modules

- `scripts.ts` holds every page script and shared selector.
- `terminal-browser.ts`, `chrome-browser.ts` and `builtin-browser.ts` adapt each backend behind the injected `Browser`. The last two share `mcp-browser.ts` (MCP calls, the page-script upload and `waitFor` polling).
- `browsers.ts` chooses the backend.
- `register.tsx` builds the MCP calls and, in a `tool.check` hook, allows the plugin's own browser calls that stay on chatgpt.com (auto mode's classifier gives no verdict on them).
- `ask.ts`, `image.ts` and `conversation.ts` are the flows.
- `runner.ts` queues requests and runs background jobs.
- `output.ts` saves answers and images to `$TMPDIR/chatgpt/`.

A `prompt.compose` section tells Claude to use `ask` unprompted.
