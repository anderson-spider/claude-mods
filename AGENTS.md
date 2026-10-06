# AGENTS.md

Claude Code plugin marketplace (`anderson-spider/spider-marketplace`). It currently has six plugins: `blast-radius` (holds destructive commands), `branch-guard` (holds commit and push on the protected branch), `pr-preview` (holds `gh pr create`, `gh pr edit`, `glab mr create` and `glab mr update` and previews them), `review-panel` (read-only pane with the diff, the open PR, its CI jobs and its comments), `tailscale` (tools to query and modify the tailnet) and `usage-line` (context and rate-limit usage above the prompt). The README and other documentation are in English; code comments and user-facing messages are in English too. Pull request titles and descriptions are in English.

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

## pr-preview

Same design as branch-guard (pure `hooks/guard.ts` with an injected `Probe`, `hooks/register.tsx` with `hold`/`draw`), with its own state (`pr-preview`/`held`). It holds every `gh pr create`, `gh pr edit`, `glab mr create` and `glab mr update`, not only risky ones, because opening or changing a PR is outward-facing. `classify` returns a `Draft` per command, with `action` `create` or `edit` (an edit only changes what it is given, so `check` skips the missing title, description, assignee and label, and `measure` skips the branch lookup) (options read per platform: `-d` is `--draft` on GitHub and `--description` on GitLab, `-b` is `--body` on GitHub and `--target-branch` on GitLab; the last occurrence of a single-valued option wins). `check` returns the `Problem`s against `RULES` (per platform: assignee, label, description language) plus the title, AI-mention and description checks; `textOf` pulls a heredoc description out of `"$(cat <<'EOF' … EOF)"`; `language` guesses `pt` or `en` from stopwords. `measure` reads `--body-file` with `cat` and the branch with `git branch --show-current`, and returns the report plus the `advice` text sent to Claude on `Fix`. The parser (`parse`, `resolve`, `locate`, `enter`, `bare`) is a **copy** of the one in `branch-guard/hooks/guard.ts`: a fix on one side must be carried to the other. With no answer in `AUTO_PROCEED_SECONDS` (10) `hold` proceeds on its own, even with problems; `remaining` in the state feeds the footer countdown (the test host sleeps 5 ms per poll, so it runs fast there). The band has an extra `Fix` button, and `CHROME_ROWS` does not count the problem and note rows, which `register.tsx` subtracts from the room.

## review-panel

Holds nothing: `/review-panel` (`$.command.register`, answered in `command.run`) opens a pane with `$.ui.open`, drawn by a `ui.render` hook on `{ component: 'Pane', requestId: 'review-panel' }`. `hooks/panel.ts` is pure (injected `Probe`, same design as the other plugins): `readAll` returns the branch, the diff (`git diff HEAD` plus `git ls-files --others`) and a `PrView` read from `origin`: `gh pr view --json …` plus `gh api repos/<path>/pulls/<n>/comments` for GitHub, `glab api --hostname <host>` (merge request by `source_branch`, `/discussions`, `/pipelines/<id>/jobs`) for every other host. `foldGithub` and `foldGitlab` normalise both into `PrSnapshot` (the shape follows herdr-reviewr's `PrSnapshot`). The view lives in `$.state` (`review-panel`/`view`); the 30 s poll is a `$.clock.every` started once in `command.run`, kept in a module variable (a reload starts it over). `register.tsx` flattens each tab into rows and scrolls by an `offset` held in the state. `readAll` never rejects: an error becomes `diffError` or `{ kind: 'error' }`.

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
