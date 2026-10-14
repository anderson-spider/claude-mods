# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in `plugins/<name>/` and is listed in `.claude-plugin/marketplace.json`. The plugins are function hooks mods ([mods overview](https://code.claude.com/docs/en/plugins/mods)), an early-access API that may change between Claude Code versions.

## Plugins

| Plugin | What it does |
| --- | --- |
| [chatgpt](plugins/chatgpt/README.md) | Lets Claude ask your logged-in ChatGPT, or have it generate an image, in terminal-browser, Claude in Chrome or the Claude desktop app's built-in browser, and saves the result locally. |
| [codex-computer-use](plugins/codex-computer-use/README.md) | Routes native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [git-master](plugins/git-master/README.md) | Registers git-master, a Haiku subagent for git work (status, branches, commits, rebase, push, pull and merge requests) that the session calls whenever a request is about git. |
| [gitlab](plugins/gitlab/README.md) | Opens, edits, comments on, reviews and (when asked, behind guards) merges GitLab merge requests, lists yours across projects, manages labels and runs and reads pipelines, jobs, artifacts and job errors, picking the host and its token from the git remote. |
| [session-hud](plugins/session-hud/README.md) | A three-row card above the prompt: model, context, cache and cost; the five-hour and seven-day limits with their pace; the running subagents, the last turn, edits and errors. |
| [spider-team](plugins/spider-team/README.md) | Native Spider Team specialists with Jev model and effort routing. |
| [tailscale](plugins/tailscale/README.md) | Lets Claude query and modify your tailnet through the Tailscale API, with the key in the sensitive `apiKey` plugin option. |

Each plugin README covers its setup, what it reads, sends and saves, and what its tests do and do not prove. Read it before sending private context or granting write access.

## Install

Requires Claude Code v2.1.287 or later. The repository is checked with v2.1.300 (`claude --version`).

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install chatgpt@spider-claude-mods
/plugin install codex-computer-use@spider-claude-mods
/plugin install git-master@spider-claude-mods
/plugin install gitlab@spider-claude-mods
/plugin install session-hud@spider-claude-mods
/plugin install spider-team@spider-claude-mods
/plugin install tailscale@spider-claude-mods
```

From a local copy: `/plugin marketplace add ~/dev/personal/claude-mods`.

### One step on a Mac

`scripts/bootstrap.sh` adds the marketplace, installs or updates chatgpt, codex-computer-use and tailscale, and installs the codex-computer-use helper (a LaunchAgent). The repository is private, so it borrows the `gh` token:

```
curl -fsSL -H "Authorization: Bearer $(gh auth token)" -H 'Accept: application/vnd.github.raw' \
  https://api.github.com/repos/anderson-spider/claude-mods/contents/scripts/bootstrap.sh | sh
```

Add `-s -- --check` after `sh` for a dry run, or `-s -- --only tailscale,chatgpt` to limit the plugins. It is safe to rerun, skips the helper when the ChatGPT app is missing and never sets secrets: use `claude plugin configure tailscale` for `apiKey`.

### Update

From the main checkout, `mise run update:all` pulls `main` (fast-forward only, clean tree) and updates every installed plugin; then run `/reload-plugins` or start a new session.

## Contributing

Rules for changing the code, the done definition and the project skills are in [AGENTS.md](AGENTS.md). Setup: `mise install`.

Load a plugin from its folder so edits reload automatically, with `claude --plugin-dir plugins/<name>` or in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/plugins/<name>" } }
```

| Task | What it does |
| --- | --- |
| `mise run plugin:new <name> [description]` | Scaffold a plugin that passes the consistency checks, then generate its typings. |
| `mise run plugins:types [name]` | Generate the `claude-code` typings a plugin's `tsconfig.json` extends. |
| `mise run plugins:validate` | `validate --strict` the marketplace and every plugin, then `check-consistency`. |
| `mise run plugins:test` | Script tests, every plugin's tests and, with the ChatGPT app installed, the codex-computer-use helper tests. |
| `mise run plugins:scan` | Save each plugin's `validate --strict` output under `.scan/` to diff before and after a refactor. |
| `mise run plugins:update` | Refresh the marketplace and update every installed plugin in its own scope. |
| `mise run update:all` | Pull `main` and run `plugins:update` (main checkout only). |

`/reload-plugins` and `claude plugin details` report `0 hooks` for every plugin here, because they count only `hooks.json` command hooks and these plugins ship hooks modules. `claude plugin validate plugins/<name>` lists a module's events and `$` calls; a module that fails to load leaves a line in `claude --debug`.

Unit tests run against host fakes: a Claude Code update can break a plugin without a test failing here. Use `/live-test <plugin>` for real-session checks.
