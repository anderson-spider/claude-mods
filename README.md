# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in `plugins/<name>/` and is listed in `.claude-plugin/marketplace.json`. The plugins are function hooks mods ([mods overview](https://code.claude.com/docs/en/plugins/mods)), an early-access API that may change between Claude Code versions.

## Plugins

| Plugin | What it does |
| --- | --- |
| [chatgpt](plugins/chatgpt/README.md) | Lets Claude ask your logged-in ChatGPT, or have it generate an image, in terminal-browser, Claude in Chrome or the Claude desktop app's built-in browser, and saves the result locally. |
| [codex-computer-use](plugins/codex-computer-use/README.md) | Routes native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [git-cleanup](plugins/git-cleanup/README.md) | A skill that lists stale worktrees and merged or orphaned branches of any repository and deletes only what you approve, never protected branches. |
| [gitlab](plugins/gitlab/README.md) | Opens, edits, comments on, reviews and (when asked, behind guards) merges GitLab merge requests, lists yours across projects, lists open review threads, manages labels and runs, waits for and reads pipelines, jobs, artifacts and job errors, picking the host and its token from the git remote. |
| [session-hud](plugins/session-hud/README.md) | A card above the prompt: model, context and cache; the five-hour and seven-day limits with their pace; the running subagents with their type, model and effort, and the tokens they used; what the last turn sent and added, edits and errors. |
| [spider-team](plugins/spider-team/README.md) | Read-only analyst, planner and reviewer subagents; Jev picks each one's model and effort from the task. |
| [tailscale](plugins/tailscale/README.md) | Lets Claude query and modify your tailnet through the Tailscale API, with the key in the sensitive `apiKey` plugin option. |

Each plugin README covers its setup, what it reads, sends and saves, and what its tests do and do not prove. Read it before sending private context or granting write access.

## Install

Requires Claude Code v2.1.287 or later. The repository is checked with v2.1.301 (`claude --version`).

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install chatgpt@spider-claude-mods
/plugin install codex-computer-use@spider-claude-mods
/plugin install git-cleanup@spider-claude-mods
/plugin install gitlab@spider-claude-mods
/plugin install session-hud@spider-claude-mods
/plugin install spider-team@spider-claude-mods
/plugin install tailscale@spider-claude-mods
```

From a local copy: `/plugin marketplace add /path/to/claude-mods`.

codex-computer-use also needs a local helper on the Mac: follow [its install steps](plugins/codex-computer-use/README.md#install), or use the one-step setup below.

### One step

`scripts/bootstrap.sh` adds the marketplace and installs or updates every plugin. On macOS it also installs the codex-computer-use helper (a LaunchAgent); on Linux it leaves codex-computer-use out, since that plugin controls native Mac apps:

```
curl -fsSL https://raw.githubusercontent.com/anderson-spider/claude-mods/main/scripts/bootstrap.sh | sh
```

Add `-s -- --check` after `sh` for a dry run, or `-s -- --only tailscale,chatgpt` to limit the plugins. It is safe to rerun, skips the helper when the ChatGPT app is missing and never sets secrets: use `claude plugin configure gitlab` for its `tokens` and `claude plugin configure tailscale` for its `apiKey`.

### Update

Refresh the marketplace, then update each plugin you installed; run `/reload-plugins` or start a new session afterwards:

```
claude plugin marketplace update spider-claude-mods
claude plugin update <plugin>@spider-claude-mods
```

Rerunning the one-step command does both for every plugin. From the main checkout, `npm run update:all` pulls `main` (fast-forward only, clean tree), reinstalls the pinned tools and updates every installed plugin; then run `/reload-plugins` or start a new session.

## Contributing

Rules for changing the code, the done definition and the project skills are in [AGENTS.md](AGENTS.md). Setup: Node 24 (`.nvmrc`), then `npm ci`, which installs the pinned Claude Code CLI and TypeScript; `npm run` puts them first on PATH.

Pull requests from forks run CI without secrets and are merged only after a maintainer reads the whole diff: the code runs on every installed copy. Use placeholders, never real hosts, project names, paths or tokens, in code, tests and examples. Report vulnerabilities privately as [SECURITY.md](SECURITY.md) describes.

Load a plugin from its folder so edits reload automatically, with `claude --plugin-dir plugins/<name>` or in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/plugins/<name>" } }
```

| Task | What it does |
| --- | --- |
| `npm run plugin:new -- <name> [description]` | Scaffold a plugin that passes the consistency checks, then generate its typings. |
| `npm run plugins:types [-- <name>]` | Generate the `claude-code` typings a plugin's `tsconfig.json` extends. |
| `npm run plugins:validate` | `validate --strict` the marketplace and every plugin, then `check-consistency`. |
| `npm run typecheck [-- <name>]` | Run the pinned `tsc` on one plugin, or every plugin with TypeScript; the typings must exist (`plugins:types`). |
| `npm run plugins:test` | Script tests, every plugin's tests and, with the ChatGPT app installed, the codex-computer-use helper tests. |
| `npm run plugins:scan` | Save each plugin's `validate --strict` output under `.scan/` to diff before and after a refactor. |
| `npm run plugins:update` | Refresh the marketplace and update every installed plugin in its own scope. |
| `npm run update:all` | Pull `main`, run `npm ci` and `plugins:update` (main checkout only). |
| `npm run install:test` | Install the marketplace from the checkout on a clean Linux image (Docker) as a new user would, and check that every plugin loads. |

`/reload-plugins` and `claude plugin details` report `0 hooks` for every plugin here, because they count only `hooks.json` command hooks and these plugins ship hooks modules. `claude plugin validate plugins/<name>` lists a module's events and `$` calls; a module that fails to load leaves a line in `claude --debug`.

Unit tests run against host fakes: a Claude Code update can break a plugin without a test failing here. Use `/live-test <plugin>` for real-session checks.

## Acknowledgments

These projects inspired plugins in this marketplace:

- [claude-mods-computer-use-threads](https://github.com/promptadvisers/claude-mods-computer-use-threads) by Prompt Advisers: the Codex computer-use bridge behind [codex-computer-use](plugins/codex-computer-use/README.md).
- [JevFlow](https://github.com/Parth1811/JevFlow) by Parth Patil: the Jev outcome judge behind [spider-team](plugins/spider-team/README.md).

## License

[MIT](LICENSE).
