# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in a folder under `plugins/` and is listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [blast-radius](plugins/blast-radius) | Holds a risky Bash command and shows what it would change before it runs. |
| [branch-guard](plugins/branch-guard) | Holds a `git commit` or `git push` on the protected branch and shows what would go in. |
| [codex-computer-use](plugins/codex-computer-use) | Routes native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [pr-preview](plugins/pr-preview) | Holds a `gh pr create`, `gh pr edit`, `glab mr create` or `glab mr update`, previews the title and description and flags what breaks the conventions. |
| [review-panel](plugins/review-panel) | Opens a read-only pane with the worktree diff, the open pull or merge request, its CI jobs and the comments already made. |
| [tailscale](plugins/tailscale) | Lets Claude query and modify your tailnet through the Tailscale API. |
| [usage-line](plugins/usage-line) | Keeps the context fill and the 5h and 7d rate-limit windows above the prompt, as the status line shows them. |

## Install

Inside Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add anderson-spider/spider-marketplace
/plugin install blast-radius@spider-marketplace
/plugin install branch-guard@spider-marketplace
/plugin install codex-computer-use@spider-marketplace
/plugin install pr-preview@spider-marketplace
/plugin install review-panel@spider-marketplace
/plugin install tailscale@spider-marketplace
/plugin install usage-line@spider-marketplace
```

To use a local copy instead of GitHub, pass the folder path:

```
/plugin marketplace add ~/dev/personal/spider-marketplace
```

The plugins here are function hooks mods, a Claude Code API still in early access that may change between versions.

## blast-radius

When Claude calls Bash with a destructive command, Blast Radius holds the call, measures what it would change using the tools' own dry runs, and shows the report in a band above the prompt: a `Command` row, a `Would` row with the summary (e.g. "delete 9 files (1.1 MB)"), the affected items (`… and N more` when the list is cut), and the `Proceed` (key `1`) and `Cancel` (key `2`) buttons. On cancel, Claude gets the refusal along with a summary of what the command would do.

| Command | How it is measured |
| --- | --- |
| `rm -r`, `rm -rf` | `find` and `du` on the targets: "delete 9 files (1.1 MB)" |
| `git reset --hard` | `git status --porcelain`, `git diff --shortstat` and `git log <ref>..HEAD` |
| `git clean -f` | `git clean -n` with the same flags |
| force push (`-f`, `--force`, `--force-with-lease`, `+ref`) | `git log HEAD..<remote>/<branch>`, without a fetch |
| database migration (Django, Rails, Prisma, Laravel) | each tool's status command |

`rm -rf`, `git reset --hard` and `git clean` pass without asking when they only touch a system temporary directory (`/tmp`, `/private/tmp`, `/var/folders`), including when the path comes from a variable assigned on the same line (`S=/tmp/x; rm -rf $S`). The temp root itself, mixed targets, targets only the shell can resolve, and worktrees linked to an outside repository are still held.

It is a safety net, not a permission system: the plugin reads the command text, so `$(…)`, aliases and scripts that call `rm` internally get past it. For a real block, use Claude Code's permission rules.

## branch-guard

When Claude calls Bash with `git commit` or `git push` and the target branch is `main`, `master`, `develop`, `release` or `release/*` (also `release-*` and `release_*`), Branch Guard holds the call and shows in the band above the prompt what would go in: the commit's files or the commits that would be pushed, in the same band layout (`Command`, `Would`, `… and N more`, `Proceed` on key `1`, `Cancel` on key `2`). On cancel, Claude gets the refusal with guidance to open a working branch (`git switch -c`) and redo the command there, or to open a PR when the push is `HEAD:<protected>` from another branch.

Passes without asking: commits and pushes on other branches, on a detached HEAD, in a repository inside `/tmp`, `git commit --dry-run`, `git push --dry-run`, tag-only pushes and commits with nothing staged. Force push is not handled here: it belongs to blast-radius. To turn the warning off, disable only this plugin.

Limitations: the plugin reads the command text, so `merge`, `cherry-pick`, `rebase`, `pull`, aliases and `bash -c "git commit"` do not go through it; a stray `"` or `'` in the body of a `-m "$(cat <<EOF …)"` can confuse the parsing; it only sees what Claude types, not your terminal.

## codex-computer-use

Lets Claude control native Mac apps (Calculator, TextEdit, Finder…) through Codex computer use, the engine bundled with the ChatGPT desktop app, which clicks and types inside apps in the background without taking over the mouse. Claude still decides what to do; Codex carries out the clicks and typing.

It has three pieces:

| Piece | What it does |
| --- | --- |
| `helper/launch.mjs` (the `codex-cu` connection) | Reads `mcpServers.cua_repl` from the newest `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json` and starts it with the desktop surface only, so a ChatGPT update needs no edit (a protocol change can still break it). `--check` lists what it would start, without env values. |
| `helper/helper.mjs` (LaunchAgent `com.anderson-spider.codex-cu`) | MCP client of that connection, served on `~/.claude/mcp/codex-cu/run/helper.sock` (directory `0700`, socket `0600`). One Codex session per caller (a Claude session, or `<session>/<agent>` for a subagent), calls serialized per caller, app approvals answered only from your choices, an app owned by one caller until 2 minutes after its last call, at most 8 Codex sessions (the quietest idle one makes room), 15 minutes idle expiry. |
| the plugin | The `mcp__codex-computer-use__codex_cu` tool, the approval band, the `/codex-cu` command, a system-prompt section on how to drive the API, and a block on Claude's own desktop computer-use tools (`mcp__computer-use__*`, `mcp__remote-devices__computer*`) while on. Browsers, CLIs and purpose-built tools stay available. |

The first use of an app asks in a band above the prompt: `This session` (key `1`), `Always` (key `2`, also saved in Codex's own `ComputerUseAppApprovals.json`) or `No` (key `3`). A `No` is kept for that caller and the call is refused without asking again; organization and safety blocks from Codex pass through as they are. The first call of a new or reset Codex session must be one documented entry call (`await cua.getState();` or `let app = await cua.getApp("Calculator");`), whose result carries the API documentation.

```
/codex-cu on | off | status
/codex-cu forget            drop this session's answers (This session / No)
/codex-cu forget <app>      take <app> off "always allow" in the helper and in Codex
/codex-cu auto-approve on | off
```

Requirements: macOS, the ChatGPT desktop app with Computer Use turned on in Codex (`/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node` and the `.mcp.json` above). After installing the plugin, install the helper once from a clone:

```
plugins/codex-computer-use/helper/install.sh
```

It copies the helper to `~/.claude/mcp/codex-cu` (keeping `state/`, where the approvals and the log live) and loads the LaunchAgent; run it again after a helper change. `uninstall.sh` removes the LaunchAgent and leaves the files. To load the plugin from the folder instead of the marketplace, pass `--plugin-dir plugins/codex-computer-use`, which adds it to `CLAUDE_CODE_PLUGIN_DIRS`.

Limitations: ownership is checked for apps named as string literals in `cua.getApp(...)` and for the app each result reports, so an app reached through a variable is owned only after its first call; Codex refuses an action when the app changed since it was last read ("The user changed …"), so read and act in the same call.

## pr-preview

When Claude calls Bash with `gh pr create`, `gh pr edit`, `glab mr create` or `glab mr update` (also `glab-work`, `glab-personal` and other `glab-*` wrappers), PR Preview holds the call and shows in the band above the prompt what would be opened or changed: the title, the branches, the assignee, the labels and the start of the description, with `Proceed` (key `1`), `Fix` (key `2`, only when something is wrong) and `Cancel` (key `3`). On `Fix`, Claude gets the list of problems with what to change and reruns the command; on `Cancel`, it gets the refusal.

An edit (`gh pr edit`, `glab mr update`) only changes what it is given, so the title, the description and any mention of AI are checked when present, and a missing title, description, assignee or label is not a problem.

It flags what breaks these conventions, in red under the preview:

| Rule | GitHub | GitLab |
| --- | --- | --- |
| Title | Conventional Commits, in English | Conventional Commits, in English |
| Description | English | Brazilian Portuguese |
| Assignee | not required | `--assignee @me` |
| Label | not required | at least one `--label` |
| Mentions of AI (`Co-Authored-By`, "Generated with", Claude, ChatGPT…) | flagged | flagged |

The conventions live in `RULES` and the regexes of `hooks/guard.ts`. The description is read from `--body`/`--description`, from a `"$(cat <<'EOF' … EOF)"` heredoc or, for `--body-file`, with `cat`; with `--fill` the title and description come from the commits and are not checked. The language is guessed from common words and stays silent when the text says too little.

Limitations: the plugin reads the command text, so aliases, `bash -c "gh pr create"` and a title or description that only the shell expands (`$VAR`) are previewed as "not readable" and not checked; only the first command on a line is previewed; it only sees what Claude types, not your terminal.

## review-panel

`/review-panel` opens a pane beside the conversation that only reads, never writes. The **Diff** tab (key `1`) shows what changed against `HEAD` (staged, unstaged and untracked), file by file, with `+` and `-` lines in colour. The **PR** tab (key `2`) shows the pull or merge request of the current branch: title, state, branches, merge blockers, description, the CI checks or jobs (one line each) and the comments already made (reviews, plain comments and inline ones, newest first, with `resolved`/`outdated` marks). `Refresh` (key `r`) reads again; it also reads every 30 seconds while the pane is open. `▲`/`▼` (keys `k`/`j`) scroll.

It reads the forge from the `origin` remote: `gh` for GitHub, `glab api --hostname <host>` for any other host (so `gitlab.com` and a self-hosted GitLab work with the same `glab`, as long as it is authenticated for that host). Only `GET` reads run. The pane takes keys after a click on it; `Esc` gives the focus back.

Limitations: GitHub's REST inline comments do not say whether a thread is resolved, so only `outdated` shows there; each list is capped (100 rows from the forge, the newest 30 comments shown); a GitLab merge request is found by its source branch, so a branch with several shows the most recently updated.

## tailscale

Registers two tools for Claude to talk to the Tailscale API (`https://api.tailscale.com/api/v2`), authenticated by the `TS_API_KEY` environment variable, which must be exported when Claude Code starts:

| Tool | What it does |
| --- | --- |
| `mcp__tailscale__tailscale_get` | Read-only (`GET`): devices, ACL, DNS, keys, users, invites, settings, webhooks, logs, device posture, services, OAuth apps and contacts. E.g. `/tailnet/-/devices`. Accepts `fields` to return only the requested keys (the API does not paginate, so the whole list comes back). Strips `machineKey`, `nodeKey`, `tailnetLockKey`, `secret`, `s3SecretAccessKey` and `token` from the response and shows the `ETag` when there is one. |
| `mcp__tailscale__tailscale_write` | Modifies the tailnet (`POST`, `PUT`, `PATCH`, `DELETE`): tags, routes, ACL, DNS, deleting devices, keys, webhooks. Accepts `ifMatch`. The response comes back complete, because the API shows a new key's secret only once. |

They are separate so you can allow read-only without a prompt and keep write asking for confirmation. The `path` must be relative to the API and start with `/`; `//host`, `..`, `%2e`, `%2f`, `%5c` and full URLs are rejected. A `-` in place of the tailnet means the default one.

To update the ACL without overwriting someone else's edit: do a `GET /tailnet/-/acl`, keep the response's `ETag` and pass it in `ifMatch` on the `POST /tailnet/-/acl` (the API responds 412 if the ACL changed). A string `body` that is not valid JSON is sent as HuJSON, so a policy with comments works. `DELETE /tailnet/{tailnet}`, which deletes the whole tailnet, is refused by the tool.

`TS_API_KEY` must be a `tskey-api-...` key. An OAuth secret `tskey-client-...` is not valid as a Bearer without a token exchange, which the plugin does not do.

## usage-line

Keeps three cards above the prompt with what the status line's second row shows. Each card has the label and the percent on the left and the detail on the right: `ctx 24%` with the context window's tokens (`244k / 1M`), `5h 23% ▼50` and `7d 7% ●` with the time to the window's reset (`1h 21m`, `6d 14h`).

The pace is the use minus the share of the window already gone, in points: `▼50` in green has room to spare, `▲17` in red is spending fast, and `●` is within 5 points of the pace either way; it is left out in the window's first 1%. Only the percent is bold: it stays in the text colour below 50%, turns amber from 50% and red from 80%, and the card's border shows in that colour; at rest a card is a plain fill with no border. The green and red are the desktop diff's (`#2FD84C`, `#FF2B56`); each colour has a dark-theme and a light-theme shade, picked from the `theme` in `/config`. On the desktop app the text is drawn as SVG in the monospace font the diff header uses, so it cannot be selected.

The figures are the ones Claude Code hands the status line (`$.session.usage()`); they refresh after each turn, when a window moves a point, and every 30 seconds for the countdown. On a band too narrow or too short for the cards it falls back to one line, `ctx 24% · 244k / 1M  │  5h 23% ▼50 · 1h 21m  │  7d 7% ● · 6d 14h`. It gives way to another plugin's band (blast-radius, branch-guard, pr-preview) and to surveys.

Limitations: off a subscription there are no rate-limit windows, so only `ctx` shows; with the `auto` theme, or when the desktop app's theme differs from `/config`'s, it uses the dark shades.

## Development

To edit a plugin with automatic reload, point Claude Code straight at its folder, with `claude --plugin-dir` or in the `env` of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/spider-marketplace/plugins/blast-radius"
  }
}
```

To validate and test:

```
claude plugin validate .
claude plugin validate plugins/blast-radius
claude plugin test plugins/blast-radius
claude plugin validate plugins/branch-guard
claude plugin test plugins/branch-guard
claude plugin validate plugins/codex-computer-use
claude plugin test plugins/codex-computer-use
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/helper.test.mjs
claude plugin validate plugins/pr-preview
claude plugin test plugins/pr-preview
claude plugin validate plugins/review-panel
claude plugin test plugins/review-panel
claude plugin validate plugins/tailscale
claude plugin test plugins/tailscale
claude plugin validate plugins/usage-line
claude plugin test plugins/usage-line
```
