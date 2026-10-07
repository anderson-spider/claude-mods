# AGENTS.md

Claude Code plugin marketplace (`anderson-spider/spider-marketplace`). It currently has five plugins: `branch-guard` (holds commit and push on the protected branch), `chatgpt` (asks the user's ChatGPT, or has it generate an image, in terminal-browser), `codex-computer-use` (routes native Mac app control through Codex computer use, with a local helper), `tailscale` (tools to query and modify the tailnet) and `token-weather-usage` (a usage line above the prompt, and suggested next prompts). The README and other documentation are in English; code comments and user-facing messages are in English too. Pull request titles and descriptions are in English.

## Structure

- `.claude-plugin/marketplace.json` lists the plugins; each plugin lives in `plugins/<name>/`.
- The plugins are **function hooks mods**, an early-access Claude Code API that may change between versions. The `claude-code` module (`atom`, `read`, `Register`, `claude-code/testing`) does not come from npm: Claude Code writes the typings to `plugins/*/.claude-plugin/types/` when it loads the plugin (git-ignored). There is no `package.json`, build or lint; `tsconfig.json` extends those typings.
- Before writing or debugging a hooks module, load the `plugin-authoring` skill.

## Commands

```
claude plugin validate .                       # validates the marketplace
claude plugin validate plugins/branch-guard    # validates the plugin
claude plugin test plugins/branch-guard        # runs tests/branch-guard.test.ts
claude plugin test plugins/chatgpt             # same, for chatgpt
claude plugin test plugins/codex-computer-use  # same, for codex-computer-use (the plugin side)
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/helper.test.mjs   # its helper
claude plugin test plugins/tailscale           # same, for tailscale
claude plugin test plugins/token-weather-usage # same, for token-weather-usage
claude --plugin-dir plugins/branch-guard       # loads the plugin with automatic reload
```

Inside a session, `/reload-plugins` reloads the hooks.

## branch-guard

`hooks/hooks.json` only points to `./register.tsx`. The flow crosses three files:

- `hooks/guard.ts`: pure logic, no `$`. `classify(command)` reads the Bash text (`split`, `cd`, `git -C`, variables assigned on the line) and returns the `commit` and `publish` risks; `isProtectedTarget` decides, asynchronously, whether the target branch is protected; `measure` reports what would go in. Everything that touches the host goes through the injected `Probe`, which makes it testable without a real process. The parser (`parse`, `resolve`, `locate`, `isTempRepo`) came trimmed from the removed blast-radius plugin and now lives only here. Force push is left out on purpose.
- `hooks/register.tsx`: wires to the host. `tool.call` (Bash) classifies, measures and **holds** the call in `hold()` until the person decides (`proceed` releases it, otherwise it returns `deny` with the summary); `ui.render` in `AbovePrompt` draws the band; `session.start` clears state stuck from a reload.
- `types/index.d.ts`: shape of the report and of the plugin state (`BranchGuardHeld`, key `branch-guard`/`held`), declared in `PluginState`.

Details that only make sense when reading both sides:

- The decision travels through the module variable `waiting`, not through state: reads of `$.state` in a dispatch see a single moment. The state holds only what the band draws.
- The wait uses `$.process.run(['sleep', '0.25'])` and not `$.clock.sleep`, so it does not use up the hook's time. Only one call is held at a time.
- `hold()` never rejects: an error becomes `'aborted'` and denies the command.
- `CHROME_ROWS` in `register.tsx` must follow the band's fixed rows when the layout changes (border, title, `Command`, `Would`, the two blank lines, the footer, the `… and N more` line and the buttons).
- The band's strings are in English: labels `Command` and `Would`, buttons `Proceed` (key 1) and `Cancel` (key 2) and the overflow `… and N more`. The tests assert on them, so change both together.
- It is a safety net that reads text, not a permission system (`$(…)`, aliases and scripts get through).

## codex-computer-use

Two halves that talk over a Unix socket: the plugin (`hooks/`, runs in the hooks environment) and `helper/` (plain Node ESM, run by the ChatGPT app's own `node`, installed by `helper/install.sh` into `~/.claude/mcp/codex-cu` as LaunchAgent `com.anderson-spider.codex-cu`). The plugin cannot answer an MCP elicitation, which is why the helper exists: it is the MCP client of Codex's `cua_repl` server and answers its "Allow Computer Use to use <app>?" questions from the person's choices.

- `helper/launch.mjs` + `lib/config.mjs`: the `codex-cu` connection. Picks the newest `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`, starts `mcpServers.cua_repl` with `CUA_REPL_ENABLED_SURFACES=computer` (the browser surface needs Codex turn metadata Claude cannot send). Never prints env values.
- `lib/mcp-client.mjs`: newline-delimited JSON-RPC over stdio; declares `elicitation: { form: {} }` (without it node_repl refuses `getApp`) and hands `elicitation/create` to a callback.
- `lib/hub.mjs`: one session per caller (`<session>` or `<session>/<agent>`), a promise queue per caller, the entry-call check for a fresh session, ownership (`lib/owners.mjs`, by bundle id, lapsing `LEASE_MS` after the holder's last call), `MAX_SESSIONS`, idle sweep, `forget`. Apps are known before a call from `getApp("…")` literals resolved with Spotlight (`lib/apps.mjs`) and after it from the result's `_meta["codex/toolSurface"].app.appId`.
- `lib/approvals.mjs`: `decide` returns `deny`, `session`, `always`, `auto` or `ask` in that order; only the first three answers and the auto-approve switch accept. Answering `_meta.persist: "always"` makes node_repl save the app in Codex's `ComputerUseAppApprovals.json`, which node_repl then answers by itself; `lib/codex-approvals.mjs` only ever removes from that file.
- The plugin: `hooks/helper.ts` posts with `$.http.fetch({ socketPath })` and asks launchd to `kickstart` the helper when nothing listens; `hooks/routing.ts` is pure (prompt section, deny text, command parsing, model-facing answers); `hooks/register.tsx` registers `codex_cu` and `/codex-cu`, holds a `needs_approval` call with the same `waiting`/`hold` design as branch-guard (band in `AbovePrompt`, 5 minute limit) and retries after an allow.
- A declined approval comes back as `needs_approval`; the call is run again only after the person allows, so the retried code runs from the start.
- `helper/install.sh --check` only checks the prerequisites (ChatGPT's `node`, `launch.mjs --check`) and installs nothing. The approval wait is the `approvalMinutes` `userConfig` setting (default 5), read through `register(on, options)` and `limitMs` in `hooks/routing.ts`.
- The enabled switch lives in `$.store` (`enabled`, default on). `prompt.compose` runs at every render, so it needs no invalidation.
- Helper tests drive the real hub and client against `helper/test/fake-server.mjs` and always point `codexApprovals` at a temp file; never let a test reach the real `ComputerUseAppApprovals.json`.

## chatgpt

Holds nothing: it registers the `ask`, `image` and `jobs` tools (listed as `mcp__chatgpt__<name>`; their inputs are declared in `types/index.d.ts` for the matchers, kept in step with the `inputSchema`) and the `/chatgpt-ask`, `/chatgpt-image` and `/chatgpt-doctor` commands in `session.start`. A `prompt.compose` hook adds the `chatgpt:ask` section (`PROMPT` in `register.tsx`), which tells Claude to use `ask` without being asked for self-contained questions with long answers; the tools may be deferred, so their descriptions alone are not seen until loaded. It drives chatgpt.com in terminal-browser behind the injected `Browser` (`tabs`, `openTab`, `waitFor`, `js`, `upload`); `register.tsx`'s `browserOf` checks it per request: `terminal-browser ls --json` must answer, which needs Claude Code running directly in a Ghostty or kitty pane (not tmux, Herdr or a background session). The desktop app's browser pane was supported until 2026-10 and dropped to keep one backend. In `terminalBrowserOf` everything goes through `$.process.run`: `ls --json` (`listTabs`; a tab id is `<browser key>:<tab>`, `splitTabId`), `new-tab <url>` for `openTab` (`openedTab` reads the tab it names; when none is open it starts a browser in a split and names no tab, so the new browser's first tab is taken; a fresh tab answers `no CDP target yet` for a moment, which `terminalBrowser` retries), `action --browser --tab -- eval` for scripts, `action -- wait --fn <expr> --timeout <ms>` for `waitFor` (it waits inside the browser and survives a navigation), `action -- upload <selector> <paths>` for files. `action -- open` opens a new tab instead of navigating, so `findTab` moves the plugin's tab with `leaveScript` (marks the page, then `location.assign`) and waits for `LANDED` (the mark gone), then for the composer or a login page. `eval` refuses top-level `await` but waits for a returned promise.

`hooks/chatgpt.ts` is pure. Every page script is a function body that ends in `return JSON.stringify(...)`; `terminalBrowserOf` wraps it in `(async () => {…})()` for `eval`, and `parseOutput` reads the printed JSON string back. The selectors every script shares (`COMPOSER`, `LOGIN`, `STOP`, `MODEL_BUTTON`, `ANSWERS`, `GENERATED`, `SEND_SELECTOR`, `BLOCKER`) are constants interpolated into each script, `DOCTOR_SCRIPT` included, so the doctor checks the same ones. `prepare` goes to the home page (a new chat) or to `chatUrl` (`isChatUrl` only accepts `https://chatgpt.com/c/<id>`) in the plugin's own tab (`TabHolder`, kept in a module variable; `findTab` opens a new tab when it is gone, never uses a tab it did not open, and waits for the composer); `compose` picks `model` with `modelScript` (opens the model menu, clicks the entry whose label starts with it, or answers the labels on offer) and attaches `files` (by path through `upload` and `inputFor`'s selector, then `chipScript` waits for the `Remover <name>`/`Remove <name>` chip). `ask` sends with `sendScript` (a synthetic paste into the ProseMirror composer, so line breaks do not press Enter, then a click on the send button), polls `stateScript` until the stop button is gone and the answer length is the same on two reads, and reads it with `READ_SCRIPT`, which turns the answer's DOM back into Markdown. `generateImage` sends, polls `stateScript` (which also counts the generated images) until new generated images appear with the stop button gone (or returns the text when a text answer settles instead), and reads back every new one (`readImages`, one `imageScript` eval per image, which returns its base64 whole). An image tool's `reference` is just its first file: `requestOf` checks it is an image and puts it at the front of `filePaths`. `saveOnly` (both tools) sends nothing and waits while the chat is still writing. Both polls stop early on a `blocker` (`BLOCKER`: a captcha, a shown dialog or alert, an error line) that `isHardBlocker` reads as a limit or a verification, and a timeout returns `timedOut` when the chat may still finish.

`register.tsx` runs every request through `taskQueue` (one at a time, in the shared tab; the status line says how many wait ahead). `runNow` waits `FOREGROUND_MS` (6 min); a `timedOut` result starts a `saveOnly` job on its chat. `wait: false` starts a job at once (`startJob`: a detached `void (async () => …)()` with `BACKGROUND_MS`, 30 min), kept in the module's `jobs` list (lost on a reload; `jobsReport` lists them) and announced at the end with `$.ui.toast` and `$.prompt.submit`, which reaches the model as a new turn. Answers go to `$TMPDIR/chatgpt/` (`fileName`); images through `openssl base64 -d`, since `$.fs.write` only takes text, each with a 768 px JPEG preview from `sips` returned after the text as an `image` block in the Anthropic API shape (`source: { type: 'base64', media_type, data }`; the MCP shape `{ data, mimeType }` never reached the model). Attachments are checked with `$.fs.stat` (4 MiB cap; `mimeOf` names the type) and uploaded by path. `diagnose` and `report` serve `/chatgpt-doctor`. Details that only make sense when reading the host:

- The selectors follow chatgpt.com as of 2026-10: answers under `[data-markdown-text-style]`, the composer `.ProseMirror[contenteditable=true]`, the send button by `aria-label` (`Enviar`/`Send`), the stop button by `aria-label` (`Parar`/`Stop`), the model menu button by `aria-label` (`Selecionar modelo do ChatGPT`), the file inputs `input[type=file][accept="image/*"]` and the one with no `accept`, code blocks as `[data-markdown-copy=code-block]` (an editor with `data-language` and one div per line, or a `code` element with the language only in the header), inline code as `[data-markdown-copy=inline-code]`. When the UI changes, run `/chatgpt-doctor`, fix the scripts in `hooks/chatgpt.ts` and check them in the browser (`terminal-browser action -- eval`) before trusting the tests, which only cover the flow.
- A generated image is told from an attached reference by its alt text (`gerad`/`generated`) and a width over 500; the reference's preview in the composer carries its file name.

## tailscale

Holds nothing: it registers two tools with `$.tool.register` in `session.start` (`tailscale_get` and `tailscale_write`, listed as `mcp__tailscale__<name>`) and serves them in `tool.call` hooks. `hooks/api.ts` is pure: `buildUrl` only accepts a path relative to the API (no `..`, `//`, `%2e`, `%2f`, `%5c`), `forbidden` refuses `DELETE /tailnet/{tailnet}`, and `call(fetch, key, req)` receives the injected `fetch`. `transform` applies, only on `tailscale_get`, `redact` (strips `REDACTED_FIELDS`: `machineKey`, `nodeKey`, `tailnetLockKey`, `secret`, `s3SecretAccessKey`, `token`) and `fields` (projects the requested keys); `write` does not filter, because the response for a new key carries the secret only once. `call` also returns the response's `ETag`, sends `If-Match` when there is an `ifMatch`, and picks `application/hujson` when the `body` is a string that is not JSON. The API spec is the OpenAPI at `https://api.tailscale.com/api/v2?outputOpenapiSchema=true` (the `/api-docs` page is rendered by JS and `WebFetch` cannot read it); it declares itself unstable. Details that only make sense when reading the host API:

- The key comes from `$.env.get('TS_API_KEY')` on every call, never from `options` or the code.
- `validate` rejects `$.http.fetch` passed as a value; that is why `register.tsx` wraps it in `(url, init) => $.http.fetch(url, init)`.
- `result` of the `tool.call` of a custom tool is a string or array, not an object, and `isError` only accepts `true` (omit it instead of `false`).
- The test uses only the functions in `hooks/api.ts` with a fake `fetch`; there is no fake host.

## token-weather-usage

A usage line above the prompt, adapted from `plugins/token-weather-usage` 3.10.7 in `augiefra/claude-mods` (Apache-2.0: keep `LICENSE`, and list changes in `NOTICE`). It is plain ESM (`hooks/token-weather-usage.mjs`), not TypeScript, and has no `types/`: everything lives in one file, with `drawLine` and `drawSuggestions` as the only places that draw and `register(on, options)` as the only place that reads the settings (`paceStart`, `showCost`, `minAnswerChars`, `suggestSkills`). Labels are in English only; the upstream French labels and language option were removed.

- Limits: `gaugeOf` turns a window into a gauge; `pace` is used minus elapsed (points), `paceStart` (setting) is the lead still counted as on pace, red starts beyond `PACE_ALERT` (15) or at `USED_ALERT` (90). The mark (`▲ n`, `▼ n`, `▬`) comes from `pace`; the percentage is drawn only where no bar is (the narrow `nobar` and `none` modes).
- Layout: on a terminal that is too narrow `drawLine` gives up detail in steps (`textWidth(gauges, cacheNow, level)`): the cache's lifetime and lapse price, then the bars, then the reset times. A new field on the line has to be counted in `textWidth`.
- Cache: the lifetime is inferred (`ttlMs`: 1 hour with plan limits, 5 minutes otherwise); `CACHE_SOON_SHARE` makes the yellow threshold a sixth of it; the `5 min TTL · x1.25` label shows only for the short lifetime. Every dollar amount depends on the `showCost` setting (`cacheState` takes no price without it).
- Next steps: adapted from `next-steps` 1.0.0 of `claude-community` (MIT: its text and credit are in `NOTICE`). `turn.complete` forks the session (`startSuggestions`, detached) and `parseSuggestions` turns the reply into `suggestions` (module variable: `hidden`, `loading`, `offer` with `picked` in pick order); every label and prompt goes through `clean` because it is model output. The one `AbovePrompt` hook composes `[what mods after us draw, drawSuggestions, drawLine]`, so the line is always last; the block draws on the terminal only and not while `isWorking`. `1`/`2`/`3` toggle picks, `4` calls `combine` and `$.prompt.fill`; the mod never submits. Tests mock `model.fork`, `command.list` and `prompt.fill` through `suggesting` and `picking` in the test file; a hook for an event must be registered before the first `$` call.
- Tests: `tests/token-weather-usage.test.ts` can pass settings with `test(name, { options }, body)`; dollar tests use `SHOW_COST`.

## Tests

`tests/branch-guard.test.ts` uses `claude-code/testing` and a fake host (`answer`) that responds by executable and subcommand. A new git command the plugin measures needs an answer in that host.

## Version

When a plugin's behavior changes, update `version` in its `plugin.json`.

## Pull requests

Titles follow Conventional Commits in English, and descriptions are written in English. `.github/pull_request_template.md` holds the default description template.
