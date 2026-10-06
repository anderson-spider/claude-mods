# AGENTS.md

Claude Code plugin marketplace (`anderson-spider/spider-marketplace`). It currently has eight plugins: `blast-radius` (holds destructive commands), `branch-guard` (holds commit and push on the protected branch), `chatgpt` (asks the user's ChatGPT, or has it generate an image, in the browser pane), `codex-computer-use` (routes native Mac app control through Codex computer use, with a local helper), `pr-preview` (holds `gh pr create`, `gh pr edit`, `glab mr create` and `glab mr update` and previews them), `review-panel` (read-only pane with the diff, the open PR, its CI jobs and its comments), `tailscale` (tools to query and modify the tailnet) and `usage-line` (context and rate-limit usage above the prompt). The README and other documentation are in English; code comments and user-facing messages are in English too. Pull request titles and descriptions are in English.

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
claude plugin test plugins/codex-computer-use  # same, for codex-computer-use (the plugin side)
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/helper.test.mjs   # its helper
claude plugin test plugins/pr-preview          # same, for pr-preview
claude plugin test plugins/review-panel        # same, for review-panel
claude plugin test plugins/tailscale           # same, for tailscale
claude plugin test plugins/usage-line          # same, for usage-line
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

## codex-computer-use

Two halves that talk over a Unix socket: the plugin (`hooks/`, runs in the hooks environment) and `helper/` (plain Node ESM, run by the ChatGPT app's own `node`, installed by `helper/install.sh` into `~/.claude/mcp/codex-cu` as LaunchAgent `com.anderson-spider.codex-cu`). The plugin cannot answer an MCP elicitation, which is why the helper exists: it is the MCP client of Codex's `cua_repl` server and answers its "Allow Computer Use to use <app>?" questions from the person's choices.

- `helper/launch.mjs` + `lib/config.mjs`: the `codex-cu` connection. Picks the newest `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`, starts `mcpServers.cua_repl` with `CUA_REPL_ENABLED_SURFACES=computer` (the browser surface needs Codex turn metadata Claude cannot send). Never prints env values.
- `lib/mcp-client.mjs`: newline-delimited JSON-RPC over stdio; declares `elicitation: { form: {} }` (without it node_repl refuses `getApp`) and hands `elicitation/create` to a callback.
- `lib/hub.mjs`: one session per caller (`<session>` or `<session>/<agent>`), a promise queue per caller, the entry-call check for a fresh session, ownership (`lib/owners.mjs`, by bundle id, lapsing `LEASE_MS` after the holder's last call), `MAX_SESSIONS`, idle sweep, `forget`. Apps are known before a call from `getApp("…")` literals resolved with Spotlight (`lib/apps.mjs`) and after it from the result's `_meta["codex/toolSurface"].app.appId`.
- `lib/approvals.mjs`: `decide` returns `deny`, `session`, `always`, `auto` or `ask` in that order; only the first three answers and the auto-approve switch accept. Answering `_meta.persist: "always"` makes node_repl save the app in Codex's `ComputerUseAppApprovals.json`, which node_repl then answers by itself; `lib/codex-approvals.mjs` only ever removes from that file.
- The plugin: `hooks/helper.ts` posts with `$.http.fetch({ socketPath })` and asks launchd to `kickstart` the helper when nothing listens; `hooks/routing.ts` is pure (prompt section, deny text, command parsing, model-facing answers); `hooks/register.tsx` registers `codex_cu` and `/codex-cu`, holds a `needs_approval` call with the same `waiting`/`hold` design as blast-radius (band in `AbovePrompt`, 5 minute limit) and retries after an allow.
- A declined approval comes back as `needs_approval`; the call is run again only after the person allows, so the retried code runs from the start.
- The enabled switch lives in `$.store` (`enabled`, default on). `prompt.compose` runs at every render, so it needs no invalidation.
- Helper tests drive the real hub and client against `helper/test/fake-server.mjs` and always point `codexApprovals` at a temp file; never let a test reach the real `ComputerUseAppApprovals.json`.

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

## usage-line

Holds nothing and keeps no state: a `ui.render` hook on `{ component: 'AbovePrompt' }` reads `$.session.usage()`, `$.clock.now()` and the `theme` row of `$.config.list()` on every draw, and `session.measure` and a 30 s `$.clock.every` (started once in `session.start`) call `$.ui.invalidate('ui.render')` to redraw. `hooks/usage.ts` is pure: `items` turns the usage into one `Item` per reading (`ctx`, `5h`, `7d`), each with a `left` side (label, percent, pace) and a `right` one (tokens or the time to the reset) as toned `Segment`s, with the same figures as the user's status line script (`formatTokens`, `formatReset`, `paceOf`: use minus the elapsed share of the window, left out in its first 1%). `paceSegment` reads the pace in points (`▼N`, `▲N`) and as `●` within `PACE_TOLERANCE` (5). `segments` joins the cards into the one-line fallback; `cardWidth` splits `bodyColumns` evenly and returns undefined when a card's two sides do not fit or the band has under 3 rows. `PALETTE` holds a dark and a light shade per colour (raw colours do not follow the theme), chosen by `isLightTheme`. Details:

- The hook calls `next(e)` first and returns its result when it is not `{ type: 'engine' }`: another plugin's band (blast-radius, branch-guard, pr-preview) or a survey wins.
- A card is a filled `Box` (`fillOf`) with `justifyContent: 'space-between'`. Its round border is always drawn, in the fill's own colour at rest (`borderOf`), so a card that crosses 50% shows its border without changing height.
- Only the percent is bold (`styleOf`); the label and the details share the muted gray.
- `session.start` calls `$.ui.status(undefined)` to clear the status line an early build pinned; the host keeps it across reloads until cleared.
- On `desktop` each side is an `Svg` from `svgLine` (monospace `<text>` with one coloured `<tspan>` per segment, its width measured generously by `svgWidth`, wider for `▼`, `▲`, `●` and `│`, which the font may lack); the `Svg` gets no `width` prop, so a side wider than its room scales down instead of being cut. `Text` takes no font prop and the desktop draws it in its UI font, not the diff header's monospace; the terminal keeps `Text`.
- No progress bars: the desktop surface does not draw `█`/`░` at a fixed cell width, so a bar sized in columns breaks there.

## Tests

`tests/blast-radius.test.ts` uses `claude-code/testing` and a fake host (`answer`) that responds by executable and subcommand. A new risk type needs an answer in that host.

## Version

When a plugin's behavior changes, update `version` in its `plugin.json`.

## Pull requests

Titles follow Conventional Commits in English, and descriptions are written in English. `.github/pull_request_template.md` holds the default description template.
