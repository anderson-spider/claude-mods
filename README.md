# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in `plugins/<name>/` and is listed in `.claude-plugin/marketplace.json`. The plugins are function hooks mods ([mods overview](https://code.claude.com/docs/en/plugins/mods)), an early-access API that may change between Claude Code versions.

## Plugins

| Plugin | What it does |
| --- | --- |
| [chatgpt](plugins/chatgpt/README.md) | Lets Claude ask your logged-in ChatGPT, or have it generate an image, in terminal-browser, Claude in Chrome or the Claude desktop app's built-in browser, and saves the result locally. |
| [codex-computer-use](plugins/codex-computer-use/README.md) | Routes native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [coolify](plugins/coolify/README.md) | Lets Claude read your Coolify instance and create, deploy or delete projects and resources through its API, with the instance in the `url` option and the token in the sensitive `apiKey` option. |
| [file-explorer](plugins/file-explorer/README.md) | A file tree pane beside the conversation: git status per file and folder, a mark on each file Claude reads, edits, creates, removes, finds or commits, search across unopened folders, preview, and `@path` into the prompt. |
| [gitlab](plugins/gitlab/README.md) | Opens, edits, comments on, reviews and (when asked, behind guards) merges GitLab merge requests, lists yours across projects, lists open review threads, manages labels and runs, waits for and reads pipelines, jobs, artifacts and job errors, picking the host and its token from the git remote. |
| [image-preview](plugins/image-preview/README.md) | Shows images in the terminal: thumbnails of what you paste above the prompt, and each image Claude reads under its row in the transcript, as the desktop app does. |
| [session-hud](plugins/session-hud/README.md) | A card above the prompt: model, context and cache; the five-hour and seven-day limits with their pace; the running subagents with their type, model and effort, and the tokens they used; what the last turn sent and added, edits and errors. |
| [spider-progress](plugins/spider-progress/README.md) | A one-line band under the session card that follows a spider-team run (plan counts, tasks in progress, running agents) and a `/spider-agents` pane in bordered sections: the plan as a tree, each running agent with its model, effort, context, steps, tokens, cost, time and latest tools, recent agents, a 15-minute timeline and totals; it lists any subagent without spider-team too. |
| [spider-team](plugins/spider-team/README.md) | `/spider-team <task>`: the session owns and implements the task, plans it with dependencies, calls a read-only planner or reviewer (Opus) and a researcher (Haiku) when they help, splits off parallel workers (Sonnet) only when independent parts gain from it, reviews what comes back against the real diff and verifies the integrated result before delivering; a new project in an empty directory starts with a spec and a plan for your approval; `/spider-team on` keeps appending each later request to one task list. |
| [subagent-effort](plugins/subagent-effort/README.md) | Sets the reasoning effort of every native subagent call from Jev's rating of its task, leaving the model as it was, and keeps local records to compare efforts. |
| [tailscale](plugins/tailscale/README.md) | Lets Claude query and modify your tailnet through the Tailscale API, with the key in the sensitive `apiKey` plugin option. |

Each plugin README covers its setup, what it reads, sends and saves, and what its tests do and do not prove. Read it before sending private context or granting write access.

## Install

Requires Claude Code v2.1.287 or later. The repository is checked with v2.1.303 (`claude --version`).

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install chatgpt@spider-claude-mods
/plugin install codex-computer-use@spider-claude-mods
/plugin install coolify@spider-claude-mods
/plugin install file-explorer@spider-claude-mods
/plugin install gitlab@spider-claude-mods
/plugin install image-preview@spider-claude-mods
/plugin install session-hud@spider-claude-mods
/plugin install spider-progress@spider-claude-mods
/plugin install spider-team@spider-claude-mods
/plugin install subagent-effort@spider-claude-mods
/plugin install tailscale@spider-claude-mods
```

From a local copy: `/plugin marketplace add /path/to/claude-mods`.

codex-computer-use also needs a local helper on the Mac: follow [its install steps](plugins/codex-computer-use/README.md#install), or use the one-step setup below.

### One step

`scripts/bootstrap.sh` adds the marketplace and installs or updates every plugin. On macOS it also installs the codex-computer-use helper (a LaunchAgent); on Linux it leaves codex-computer-use out, since that plugin controls native Mac apps:

```
curl -fsSL https://raw.githubusercontent.com/anderson-spider/claude-mods/main/scripts/bootstrap.sh | sh
```

Add `-s -- --check` after `sh` for a dry run, or `-s -- --only tailscale,chatgpt` to limit the plugins. It is safe to rerun, skips the helper when the ChatGPT app is missing and never sets secrets: use `claude plugin configure gitlab` for its `tokens`, `claude plugin configure tailscale` for its `apiKey` and `claude plugin configure coolify` for its `url` and `apiKey`.

### Update

Refresh the marketplace, then update each plugin you installed; run `/reload-plugins` or start a new session afterwards:

```
claude plugin marketplace update spider-claude-mods
claude plugin update <plugin>@spider-claude-mods
```

Rerunning the one-step command does both for every plugin. From the main checkout, `npm run update:all` pulls `main` (fast-forward only, clean tree), reinstalls the pinned tools and updates every installed plugin; then run `/reload-plugins` or start a new session.

## Contributing

Rules for changing the code and the done definition are in [AGENTS.md](AGENTS.md). Setup: Node 24 (`.nvmrc`), then `npm ci`, which installs the pinned Claude Code CLI and TypeScript; `npm run` puts them first on PATH.

Pull requests from forks run CI without secrets and are merged only after a maintainer reads the whole diff: the code runs on every installed copy. Use placeholders, never real hosts, project names, paths or tokens, in code, tests and examples. Report vulnerabilities privately as [SECURITY.md](SECURITY.md) describes.

Load a plugin from its folder so edits reload automatically, with `claude --plugin-dir plugins/<name>` or in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/plugins/<name>" } }
```

| Task | What it does |
| --- | --- |
| `npm run plugin:new -- <name> [description]` | Scaffold a plugin that passes the consistency checks, then generate its typings. |
| `npm run plugins:types [-- <name>]` | Generate the `claude-code` typings a plugin's `tsconfig.json` extends. |
| `npm run check [-- <name>]` | The required CI checks in one run: the version bump of committed and uncommitted changes against `origin/main` as last fetched, then `plugins:validate`, `plugins:test` and `typecheck`, for every plugin or one. Every step runs, and a summary names the failed ones. |
| `npm run plugins:validate [-- <name>]` | `validate --strict` the marketplace and every plugin, or one plugin, then `check-consistency`. |
| `npm run typecheck [-- <name>]` | Run the pinned `tsc` on one plugin, or every plugin with TypeScript; the typings must exist (`plugins:types`). |
| `npm run plugins:test [-- <name>]` | Script tests, every plugin's tests and, with the ChatGPT app installed, the codex-computer-use helper tests; with a name, only that plugin's tests. |
| `npm run plugins:scan` | Save each plugin's `validate --strict` output under `.scan/` to diff before and after a refactor. |
| `npm run plugins:sync` | Refresh the marketplace, then update every installed plugin it lists and uninstall those it no longer lists, each in its own scope. |
| `npm run update:all` | Pull `main`, run `npm ci` and `plugins:sync` (main checkout only). |
| `npm run install:test` | Install the marketplace from the checkout on a clean Linux image (Docker) as a new user would, and check that every plugin loads. |

`/reload-plugins` and `claude plugin details` report `0 hooks` for every plugin here, because they count only `hooks.json` command hooks and these plugins ship hooks modules. `claude plugin validate plugins/<name>` lists a module's events and `$` calls; a module that fails to load leaves a line in `claude --debug`.

Unit tests run against host fakes: a Claude Code update can break a plugin without a test failing here. Check real behavior in a session that loads the plugin from its folder (`claude --plugin-dir plugins/<name>`).

## Acknowledgments

These projects inspired or are the base of plugins in this marketplace:

- [claude-mods-computer-use-threads](https://github.com/promptadvisers/claude-mods-computer-use-threads) by Prompt Advisers: the Codex computer-use bridge behind [codex-computer-use](plugins/codex-computer-use/README.md).
- [claude-image-view](https://github.com/jarrodwatts/claude-image-view) by Jarrod Watts (MIT): [image-preview](plugins/image-preview/README.md) is a copy of it with fixes.

## License

[MIT](LICENSE).
