# chatgpt

Ask your logged-in ChatGPT for self-contained long answers; generate or edit images when you request them.

```text
/plugin install chatgpt --marketplace anderson-spider/claude-mods
```

## Setup and use

Log in to chatgpt.com in one supported browser: [terminal-browser](https://terminal-browser.sh) in a direct Ghostty/kitty pane (not a multiplexer/background session), Claude in Chrome, or the Claude app's built-in browser. The plugin tries them in that order; `/chatgpt-doctor` names the selected backend and checks login, composer, attachments and selectors. A login prompt stops the request; credentials are yours to enter.

| Command | Use |
| --- | --- |
| `/chatgpt-ask <question>` | Ask and show the answer. Claude also reaches for `mcp__chatgpt__ask` on its own when little context is needed. |
| `/chatgpt-image <prompt>` | Generate/edit an image; consumes your ChatGPT image quota. |
| `/chatgpt-doctor [chat URL]` | Diagnose the current page; with a chat URL, check answer/image/code-block extraction too. |

The tool schemas describe attachments, references, model selection and output paths. Use a returned `chatUrl` for follow-ups; `wait: false` starts a background job and `mcp__chatgpt__jobs` finds its status/files. Requests share the plugin's own tab and run serially. Slow requests move to the background; inspect the current wait limits with `claude plugin configure chatgpt@spider-claude-mods`. Jobs disappear on reload.

The plugin allows only its own browser calls on chatgpt.com. To skip asks for its tools, add `mcp__chatgpt__*` to your user permissions; this does not authorize sending sensitive content. Page limits, verification prompts and blocking dialogs stop the request.

## Privacy

- **Sent:** prompts and requested attachments/references go to chatgpt.com in your logged-in browser. The plugin does not read your ChatGPT credentials. Tool descriptions exclude secrets, private personal data and work data; personal-project code/files need your request.
- **Saved:** answers and image variants go to `$TMPDIR/chatgpt/` (`/tmp/chatgpt/` if unset), unless an output path is supplied. Answer files begin with the chat URL; images include JPEG previews. Generated images are labeled AI concepts, not evidence of real or in-game states.
- **Read/kept:** `TMPDIR`, requested local files, and a session-local list of background jobs.

## Tests

Plugin tests use fake browsers/page fixtures and a fake host; they cover extraction, tabs, queue/jobs, attachments and registration. They do not establish that the current chatgpt.com UI matches the selectors: run `/chatgpt-doctor` when sending or reading breaks. Live UI changes require selector updates.

For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
