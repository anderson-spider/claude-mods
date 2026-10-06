# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in a folder under `plugins/` and is listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [blast-radius](plugins/blast-radius) | Holds a risky Bash command and shows what it would change before it runs. |
| [branch-guard](plugins/branch-guard) | Holds a `git commit` or `git push` on the protected branch and shows what would go in. |
| [chatgpt](plugins/chatgpt) | Lets Claude ask your logged-in ChatGPT, or have it generate an image, in the built-in browser pane, and saves the result locally. |
| [pr-preview](plugins/pr-preview) | Holds a `gh pr create`, `gh pr edit`, `glab mr create` or `glab mr update`, previews the title and description and flags what breaks the conventions. |
| [review-panel](plugins/review-panel) | Opens a read-only pane with the worktree diff, the open pull or merge request, its CI jobs and the comments already made. |
| [tailscale](plugins/tailscale) | Lets Claude query and modify your tailnet through the Tailscale API. |

## Install

Inside Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add anderson-spider/spider-marketplace
/plugin install blast-radius@spider-marketplace
/plugin install branch-guard@spider-marketplace
/plugin install chatgpt@spider-marketplace
/plugin install pr-preview@spider-marketplace
/plugin install review-panel@spider-marketplace
/plugin install tailscale@spider-marketplace
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

## chatgpt

Sends a self-contained question to your own ChatGPT, already logged in at chatgpt.com in the Claude desktop app's built-in browser pane, waits for the answer and saves it as Markdown; it can also have ChatGPT generate or edit an image, optionally from a local reference, and save it. It saves Claude's tokens when the question needs little context and the answer is long (research, explanations, drafts, translations, a second opinion); for work that needs the repository it does not pay off, since the context would go out and the answer would come back anyway.

| Entry | What it does |
| --- | --- |
| `mcp__chatgpt__ask` | Tool for Claude: `prompt` (required), `chatUrl` (the chat link a previous call returned, to continue that chat on the same subject; left out, a new chat starts), `out` (an absolute path for the file) and `maxChars` (how much of the answer comes back inline, default 3000). |
| `mcp__chatgpt__image` | Tool for Claude: `prompt` (required), `reference` (an absolute path of a PNG, JPEG, WebP or GIF of at most 4 MiB to attach), `chatUrl`, `out` and `saveOnly` (with `chatUrl`: only save the last image already in that chat, sending nothing, e.g. after a timeout). Returns the image's path, size and chat link; when ChatGPT answers with text instead (a refusal or a question), returns that text. |
| `/chatgpt-ask <question>` | Asks from the prompt and shows the whole answer. |
| `/chatgpt-image <prompt>` | Generates an image from the prompt and saves it. |

Every request starts a new chat (the home page is one), unless a `chatUrl` brings Claude back to an earlier one. The plugin only uses a tab already on chatgpt.com, or opens one; it never touches a tab on another site. The answer goes to `$TMPDIR/chatgpt/<date>-<subject>.md`, with the chat URL on the first line; Claude gets the path, the URL and the start of the answer, and reads the rest from the file when it needs it. Code blocks keep their language, and lists, tables, quotes and math come back as Markdown. The tool's description tells Claude not to send credentials, secrets, private personal data or work data, and to treat the answer as ChatGPT's unverified opinion.

Images go to `$TMPDIR/chatgpt/<date>-<subject>.png` (or the type ChatGPT served), decoded with `openssl`. On macOS the image comes back through the clipboard (the page copies it, `osascript` writes it out); text you had copied is put back afterwards, anything else on the clipboard is replaced. When the copy does not work, the image is read from the page in slices instead. Image tools spend your ChatGPT image quota, so Claude is told to use them only when you ask for an image, to attach only references you asked for or that it made for the task, and to label the result as an AI concept.

Requirements:

- The Claude desktop app (the built-in browser pane is not in the terminal), logged in to chatgpt.com in that pane. The plugin never types credentials: when the page asks for a login, it stops and says so.
- Nothing else for the browser pane, in any permission mode, auto mode included: the plugin allows its own pane calls that stay on chatgpt.com, and nothing else. Add `mcp__chatgpt__*` to `permissions.allow` in `~/.claude/settings.json` to skip the prompt for the tools themselves.

Limitations: it reads chatgpt.com's page, so a change in ChatGPT's interface can break sending or reading until the selectors in `hooks/chatgpt.ts` are updated; a generated image is recognised by its alt text ("Imagem 1 gerada", "Generated image 1"); it waits up to 6 minutes for an answer or an image; only one request runs at a time.

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
claude plugin validate plugins/chatgpt
claude plugin test plugins/chatgpt
claude plugin validate plugins/pr-preview
claude plugin test plugins/pr-preview
claude plugin validate plugins/review-panel
claude plugin test plugins/review-panel
claude plugin validate plugins/tailscale
claude plugin test plugins/tailscale
```
