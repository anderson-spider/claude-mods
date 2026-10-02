# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in a folder under `plugins/` and is listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [blast-radius](plugins/blast-radius) | Holds a risky Bash command and shows what it would change before it runs. |
| [branch-guard](plugins/branch-guard) | Holds a `git commit` or `git push` on the protected branch and shows what would go in. |
| [tailscale](plugins/tailscale) | Lets Claude query and modify your tailnet through the Tailscale API. |

## Install

Inside Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add anderson-spider/spider-marketplace
/plugin install blast-radius@spider-marketplace
/plugin install branch-guard@spider-marketplace
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
claude plugin validate plugins/tailscale
claude plugin test plugins/tailscale
```
