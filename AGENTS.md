# AGENTS.md

Claude Code plugin marketplace (`anderson-spider/spider-marketplace`). It currently has four plugins: `blast-radius` (holds destructive commands), `branch-guard` (holds commit and push on the protected branch), `pr-preview` (holds `gh pr create` and `glab mr create` and previews them) and `tailscale` (tools to query and modify the tailnet). The README and other documentation are in English; code comments and user-facing messages are in English too. Pull request titles and descriptions are in English.

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

Same design as branch-guard (pure `hooks/guard.ts` with an injected `Probe`, `hooks/register.tsx` with `hold`/`draw`), with its own state (`pr-preview`/`held`). It holds every `gh pr create` and `glab mr create`, not only risky ones, because opening a PR is outward-facing. `classify` returns a `Draft` per creation (options read per platform: `-d` is `--draft` on GitHub and `--description` on GitLab, `-b` is `--body` on GitHub and `--target-branch` on GitLab; the last occurrence of a single-valued option wins). `check` returns the `Problem`s against `RULES` (per platform: assignee, label, description language) plus the title, AI-mention and description checks; `textOf` pulls a heredoc description out of `"$(cat <<'EOF' … EOF)"`; `language` guesses `pt` or `en` from stopwords. `measure` reads `--body-file` with `cat` and the branch with `git branch --show-current`, and returns the report plus the `advice` text sent to Claude on `Fix`. The parser (`parse`, `resolve`, `locate`, `enter`, `bare`) is a **copy** of the one in `branch-guard/hooks/guard.ts`: a fix on one side must be carried to the other. The band has an extra `Fix` button, and `CHROME_ROWS` does not count the problem and note rows, which `register.tsx` subtracts from the room.

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
