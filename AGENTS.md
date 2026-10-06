# AGENTS.md

Claude Code plugin marketplace (`anderson-spider/spider-marketplace`). It currently has six plugins: `blast-radius` (holds destructive commands), `branch-guard` (holds commit and push on the protected branch), `chatgpt` (asks the user's ChatGPT, or has it generate an image, in the browser pane), `pr-preview` (holds `gh pr create`, `gh pr edit`, `glab mr create` and `glab mr update` and previews them), `review-panel` (read-only pane with the diff, the open PR, its CI jobs and its comments) and `tailscale` (tools to query and modify the tailnet). The README and other documentation are in English; code comments and user-facing messages are in English too. Pull request titles and descriptions are in English.

## Structure

- `.claude-plugin/marketplace.json` lists the plugins; each plugin lives in `plugins/<name>/`.
- The plugins are **function hooks mods**, an early-access Claude Code API that may change between versions. The `claude-code` module (`atom`, `read`, `Register`, `claude-code/testing`) does not come from npm: Claude Code writes the typings to `plugins/*/.claude-plugin/types/` when it loads the plugin (git-ignored). There is no `package.json`, build or lint; `tsconfig.json` extends those typings.
- Before writing or debugging a hooks module, load the `plugin-authoring` skill.

## Commands

```
claude plugin validate .                       # validates the marketplace
claude plugin validate plugins/blast-radius    # validates the plugin
claude plugin test plugins/blast-radius        # runs tests/blast-radius.test.ts
claude plugin test plugins/branch-guard        # same, for branch-guard
claude plugin test plugins/chatgpt             # same, for chatgpt
claude plugin test plugins/pr-preview          # same, for pr-preview
claude plugin test plugins/review-panel        # same, for review-panel
claude plugin test plugins/tailscale           # same, for tailscale
claude --plugin-dir plugins/blast-radius       # loads the plugin with automatic reload
```

Inside a session, `/reload-plugins` reloads the hooks.

## blast-radius architecture

`hooks/hooks.json` only points to `./register.tsx`. The flow crosses three files:

- `hooks/risk.ts`: pure logic, no `$`. `classify(command)` reads the Bash text (`split`, `cd`, `git -C`, variables assigned on the line) and returns `Risk[]` (`rm`, `reset`, `clean`, `push`, `migrate`). `isDisposable` clears targets only in system temp directories. `measure` runs the tools' own dry runs and returns a `BlastRadiusReport`. Everything that touches the host goes through the injected `Probe`, which makes it testable without a real process.
- `hooks/register.tsx`: wires to the host. `tool.call` (Bash) classifies, measures and **holds** the call in `hold()` until the person decides (`proceed` releases it, otherwise it returns `deny` with the summary); `ui.render` in `AbovePrompt` draws the band; `session.start` clears state stuck from a reload.
- `types/index.d.ts`: shape of the report and of the plugin state (`BlastRadiusHeld`), declared in `PluginState`.

Details that only make sense when reading both sides:

- The decision travels through the module variable `waiting`, not through state: reads of `$.state` in a dispatch see a single moment. The state holds only what the band draws.
- The wait uses `$.process.run(['sleep', '0.25'])` and not `$.clock.sleep`, so it does not use up the hook's time. Only one call is held at a time.
- `hold()` never rejects: an error becomes `'aborted'` and denies the command.
- `CHROME_ROWS` in `register.tsx` must follow the band's fixed rows when the layout changes (border, title, `Command`, `Would`, the two blank lines, the footer, the `… and N more` line and the buttons).
- The band's strings are in English: labels `Command` and `Would`, buttons `Proceed` (key 1) and `Cancel` (key 2), overflow `… and N more`, and summaries such as `delete 9 files (1.1 MB)`. The tests assert on them, so change both together.
- It is a safety net that reads text, not a permission system (`$(…)`, aliases and scripts get through).

## branch-guard

Same design as blast-radius (pure `hooks/guard.ts` with an injected `Probe`, `hooks/register.tsx` with `hold`/`draw`), with its own state (`branch-guard`/`held`). `classify` raises `commit` and `publish`; `isProtectedTarget` decides, asynchronously, whether the target branch is protected. The parser (`parse`, `resolve`, `locate`, `isTempRepo`) is a **copy** of the one in `blast-radius/hooks/risk.ts`, because a plugin cannot import code from another: a fix on one side must be carried to the other. Force push is left out on purpose, since it belongs to blast-radius.

## pr-preview

Same design as branch-guard (pure `hooks/guard.ts` with an injected `Probe`, `hooks/register.tsx` with `hold`/`draw`), with its own state (`pr-preview`/`held`). It holds every `gh pr create`, `gh pr edit`, `glab mr create` and `glab mr update`, not only risky ones, because opening or changing a PR is outward-facing. `classify` returns a `Draft` per command, with `action` `create` or `edit` (an edit only changes what it is given, so `check` skips the missing title, description, assignee and label, and `measure` skips the branch lookup) (options read per platform: `-d` is `--draft` on GitHub and `--description` on GitLab, `-b` is `--body` on GitHub and `--target-branch` on GitLab; the last occurrence of a single-valued option wins). `check` returns the `Problem`s against `RULES` (per platform: assignee, label, description language) plus the title, AI-mention and description checks; `textOf` pulls a heredoc description out of `"$(cat <<'EOF' … EOF)"`; `language` guesses `pt` or `en` from stopwords. `measure` reads `--body-file` with `cat` and the branch with `git branch --show-current`, and returns the report plus the `advice` text sent to Claude on `Fix`. The parser (`parse`, `resolve`, `locate`, `enter`, `bare`) is a **copy** of the one in `branch-guard/hooks/guard.ts`: a fix on one side must be carried to the other. With no answer in `AUTO_PROCEED_SECONDS` (10) `hold` proceeds on its own, even with problems; `remaining` in the state feeds the footer countdown (the test host sleeps 5 ms per poll, so it runs fast there). The band has an extra `Fix` button, and `CHROME_ROWS` does not count the problem and note rows, which `register.tsx` subtracts from the room.

## review-panel

Holds nothing: `/review-panel` (`$.command.register`, answered in `command.run`) opens a pane with `$.ui.open`, drawn by a `ui.render` hook on `{ component: 'Pane', requestId: 'review-panel' }`. `hooks/panel.ts` is pure (injected `Probe`, same design as the other plugins): `readAll` returns the branch, the diff (`git diff HEAD` plus `git ls-files --others`) and a `PrView` read from `origin`: `gh pr view --json …` plus `gh api repos/<path>/pulls/<n>/comments` for GitHub, `glab api --hostname <host>` (merge request by `source_branch`, `/discussions`, `/pipelines/<id>/jobs`) for every other host. `foldGithub` and `foldGitlab` normalise both into `PrSnapshot` (the shape follows herdr-reviewr's `PrSnapshot`). The view lives in `$.state` (`review-panel`/`view`); the 30 s poll is a `$.clock.every` started once in `command.run`, kept in a module variable (a reload starts it over). `register.tsx` flattens each tab into rows and scrolls by an `offset` held in the state. `readAll` never rejects: an error becomes `diffError` or `{ kind: 'error' }`.

## chatgpt

Holds nothing: it registers the `ask` and `image` tools (listed as `mcp__chatgpt__<name>`) and the `/chatgpt-ask` and `/chatgpt-image` commands in `session.start`; each tool and its command share `run` or `runImage`. It drives chatgpt.com in the desktop app's built-in browser pane through that pane's MCP tools (server `Claude_Browser`: `tabs_context`, `preview_start`, `tabs_create`, `navigate`, `javascript_tool`), so it only works where that pane exists. `hooks/chatgpt.ts` is pure, with an injected `Browser` (same design as the other plugins): `prepare` goes to the home page (a new chat) or to `chatUrl` (`isChatUrl` only accepts `https://chatgpt.com/c/<id>`) in the chatgpt.com tab, opening the pane or a tab when there is none and never touching another site's tab, and waits for the composer; `ask` then sends the prompt with `sendScript` (a synthetic paste into the ProseMirror composer, so line breaks do not press Enter, then a click on the send button), polls `stateScript` until the stop button is gone and the answer length is the same on two reads, and reads it with `READ_SCRIPT`, which turns the answer's DOM back into Markdown. `generateImage` uploads a reference in `UPLOAD_CHUNK` (512 KiB) base64 slices (`uploadChunkScript`) and attaches it through the composer's `input[type=file][accept="image/*"]` (`attachScript`, which waits for the `Remover <name>`/`Remove <name>` chip), sends, polls `imageStateScript` until a generated image appears with the stop button gone (or returns the text when a text answer settles instead), and reads the image back (`readImage`; `saveOnly` jumps straight there for a chat's existing image): first through the injected `Clipboard` (`COPY_IMAGE_SCRIPT` copies it as PNG with `navigator.clipboard.write`; `register.tsx`'s `clipboardOf` keeps the user's text with `pbpaste`/`pbcopy` and writes the clipboard's PNG to a temporary file with `osascript`, read back as bytes; the copy counts only when `pngSize` finds the page's width and height, since the clipboard re-encodes the PNG), else in `DOWNLOAD_CHUNK` (40,000 chars) slices, since the host caps a tool's output at about 25,000 tokens (`IMAGE_SCRIPT` fetches it with the page's cookies, or redraws it on a canvas as PNG; `imageChunkScript`). `register.tsx` writes the answer to `$TMPDIR/chatgpt/` and returns the path, the chat URL and the first `maxChars` (3000) chars; an image goes to the same folder through `openssl base64 -d`, since `$.fs.write` only takes text, and a reference comes in with `$.fs.read(..., { as: 'bytes' })` (4 MiB cap). Details that only make sense when reading the host:

- Each page script returns `JSON.stringify(...)`: `javascript_tool` prints a string result as a JSON literal followed by notes about the tab, which `parseOutput` reads back.
- `call` tries `$.mcp.call` first and, through `fallbackRouter`, falls back to `$.tool.call` only when the engine refused it (`isRefusal`), staying on `$.tool.call` from then on; only the latter goes through the permission check. Any other failure is thrown, never retried, since it may come after the tool ran: a repeated `sendScript` would send the prompt twice. The pane's tools ask for permission themselves (a `mcp__Claude_Browser__*` allow rule does not clear them), and in auto mode the classifier gives no verdict on a call no prompt asked for, so a `tool.check` hook allows the plugin's own calls (`next.origin.plugin` is `chatgpt`) that `staysOnChatgpt` accepts: `tabs_context`, `tabs_create`, `preview_start` and `navigate` to `CHATGPT_URL` or a chat URL, and `javascript_tool` only in a tab in `chatTabs` (the ones the plugin opened or sent to chatgpt.com). Everything else, the model's own pane calls included, keeps the engine's decision. This skips the classifier for those calls on purpose: it could not judge them, and the model's call to `ask` or `image` that started them still goes through the permission check.
- The selectors follow chatgpt.com as of 2026-10: answers under `[data-markdown-text-style]`, the composer `.ProseMirror[contenteditable=true]`, the send button by `aria-label` (`Enviar`/`Send`), the stop button by `aria-label` (`Parar`/`Stop`), code blocks as `[data-markdown-copy=code-block]` (an editor with `data-language` and one div per line, or a `code` element with the language only in the header), inline code as `[data-markdown-copy=inline-code]`. When the UI changes, fix the scripts in `hooks/chatgpt.ts` and check them in the pane with `javascript_tool` before trusting the tests, which only cover the flow.
- A generated image is told from an attached reference by its alt text (`gerad`/`generated`) and a width over 500; the reference's preview in the composer carries its file name.
- Only one request runs at a time (`busy`): they share the tab.

## tailscale

Holds nothing: it registers two tools with `$.tool.register` in `session.start` (`tailscale_get` and `tailscale_write`, listed as `mcp__tailscale__<name>`) and serves them in `tool.call` hooks. `hooks/api.ts` is pure: `buildUrl` only accepts a path relative to the API (no `..`, `//`, `%2e`, `%2f`, `%5c`), `forbidden` refuses `DELETE /tailnet/{tailnet}`, and `call(fetch, key, req)` receives the injected `fetch`. `transform` applies, only on `tailscale_get`, `redact` (strips `REDACTED_FIELDS`: `machineKey`, `nodeKey`, `tailnetLockKey`, `secret`, `s3SecretAccessKey`, `token`) and `fields` (projects the requested keys); `write` does not filter, because the response for a new key carries the secret only once. `call` also returns the response's `ETag`, sends `If-Match` when there is an `ifMatch`, and picks `application/hujson` when the `body` is a string that is not JSON. The API spec is the OpenAPI at `https://api.tailscale.com/api/v2?outputOpenapiSchema=true` (the `/api-docs` page is rendered by JS and `WebFetch` cannot read it); it declares itself unstable. Details that only make sense when reading the host API:

- The key comes from `$.env.get('TS_API_KEY')` on every call, never from `options` or the code.
- `validate` rejects `$.http.fetch` passed as a value; that is why `register.tsx` wraps it in `(url, init) => $.http.fetch(url, init)`.
- `result` of the `tool.call` of a custom tool is a string or array, not an object, and `isError` only accepts `true` (omit it instead of `false`).
- The test uses only the functions in `hooks/api.ts` with a fake `fetch`; there is no fake host.

## Tests

`tests/blast-radius.test.ts` uses `claude-code/testing` and a fake host (`answer`) that responds by executable and subcommand. A new risk type needs an answer in that host.

## Version

When a plugin's behavior changes, update `version` in its `plugin.json`.

## Pull requests

Titles follow Conventional Commits in English, and descriptions are written in English. `.github/pull_request_template.md` holds the default description template.
