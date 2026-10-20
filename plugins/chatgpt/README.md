# chatgpt

Ask your logged-in ChatGPT for self-contained long answers; generate or edit images when you request them.

```text
/plugin install chatgpt --marketplace anderson-spider/claude-mods
```

## Setup and use

Run `/chatgpt-login` once. It installs Playwright and its Chromium build under `~/.claude/chatgpt/playwright/` (about 380 MB, the first time only; it needs Node.js 20 or newer on PATH) and opens a plain Chromium window on chatgpt.com: sign in there, then quit that browser (⌘Q on macOS, where closing the window leaves it running and holding the profile). From then on requests run in that Chromium without a window (headless), so no terminal pane or open browser is needed. The browser starts on the first request, is shared by every session and closes after ten minutes without one. When the ChatGPT session expires, a request says so: run `/chatgpt-login` again.

chatgpt.com's bot check refuses a browser that calls itself headless, so the headless Chromium presents the user agent of the same Chromium build without the "Headless" mark. If the check starts refusing it anyway, or anything other than a login keeps its page from being ready, a request moves on to the browsers you log in to yourself before anything is sent, and the answer starts with a note naming the browser it ran in. Each request tries the headless Chromium again first, which costs 20 to 40 seconds while it stays blocked; turn off **Headless Chromium first** (`claude plugin configure chatgpt@spider-claude-mods`) to skip it. Until `/chatgpt-login` has set it up, or while its login window is open, the plugin moves on to those browsers as well: [terminal-browser](https://terminal-browser.sh) in a terminal pane it can drive (a Ghostty or kitty pane; a terminal multiplexer pane running inside Ghostty was observed working, other setups are not verified; a background session has no pane), Claude in Chrome, or the Claude app's built-in browser. The plugin tries the headless Chromium first (when the setting is on), then those in that order, except inside the Claude desktop app (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`), where it tries the built-in browser right after the headless Chromium; `/chatgpt-doctor` names the selected backend and checks login, composer, attachments and selectors. A login prompt stops the request; credentials are yours to enter.

| Command | Use |
| --- | --- |
| `/chatgpt-ask <question>` | Ask and show the answer. Claude also reaches for `mcp__chatgpt__ask` on its own when little context is needed. |
| `/chatgpt-image <prompt>` | Generate/edit an image; consumes your ChatGPT image quota. |
| `/chatgpt-doctor [chat URL]` | Diagnose the current page; with a chat URL, check answer/image/code-block extraction too. |
| `/chatgpt-login` | Install the headless Chromium if needed and open its sign-in window. |

The tool schemas describe attachments, references, model selection and output paths. Without a model, a new chat uses GPT-6 at Medium effort; a named model keeps the effort it comes with, and a follow-up in a chat keeps that chat's. The model, and the effort when the plugin set it, are read back from the menu just before sending, and nothing is sent unless they still hold; each answer is read from the exchange the request added to the chat. Use a returned `chatUrl` for follow-ups; `wait: false` starts a background job and `mcp__chatgpt__jobs` finds its status/files. Requests share the plugin's own tab and run serially. Slow requests move to the background, and so does an answer whose connection drops (ChatGPT's "Connection interrupted" line), at once; inspect the current wait limits with `claude plugin configure chatgpt@spider-claude-mods`. Jobs disappear on reload.

The plugin allows only its own browser calls on chatgpt.com. To skip asks for its tools, add `mcp__chatgpt__*` to your user permissions; this does not authorize sending sensitive content. Page limits, verification prompts and blocking dialogs stop the request, except one that holds the headless Chromium's page before anything is sent, which moves it on to the next browser. The plugin moves a tab it kept from an earlier request only while that tab is on chatgpt.com or openai.com; otherwise it opens a new one.

## Privacy

- **Sent:** prompts and requested attachments/references go to chatgpt.com in your logged-in browser. The plugin does not read your ChatGPT credentials. Tool descriptions exclude secrets, private personal data and work data; personal-project code/files need your request.
- **Saved:** answers and image variants go to `$TMPDIR/chatgpt/` (`/tmp/chatgpt/` if unset), unless an output path is supplied. Answer files begin with the chat URL; images include JPEG previews. Generated images are labeled AI concepts, not evidence of real or in-game states.
- **Read/kept:** `TMPDIR`, `HOME`, requested local files, and a session-local list of background jobs. The headless Chromium keeps its ChatGPT login in its own profile under `~/.claude/chatgpt/playwright/profile/`, a sensitive login artifact: do not share it. Its helper listens on a Unix socket in a folder only you can enter and logs to `~/.claude/chatgpt/playwright/helper.log`.

## Tests

Plugin tests use fake browsers/page fixtures and a fake host; they cover extraction, tabs, queue/jobs, attachments and registration. The helper's tests (`helper/test/`, run with `node --test`) drive a fake Playwright and a real socket. They do not establish that the current chatgpt.com UI matches the selectors: run `/chatgpt-doctor` when sending or reading breaks. Live UI changes require selector updates.

For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
