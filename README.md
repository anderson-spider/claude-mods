# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in a folder under `plugins/` and is listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [chatgpt](plugins/chatgpt/README.md) | Lets Claude ask your logged-in ChatGPT, or have it generate an image, in terminal-browser, Claude in Chrome or the Claude desktop app's built-in browser, and saves the result locally. |
| [codex-computer-use](plugins/codex-computer-use/README.md) | Routes native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [codex-team](plugins/codex-team/README.md) | Dispatches Codex developers, analysts, architects and reviewers into Herdr tabs labelled `codex - <slug>` with workspace-specific names, delivery status and short reports; every dispatch starts a fresh session after retiring its settled predecessor, only agents dispatched with confirmed delivery by the current module session close and archive after complete reports, reload or lead exit drops pending closes, parallel tasks use distinct slugs, and `finish` provides recovery; publishes the active plan to Dagr after Write/Edit and shell edits. Optional Jev assessment, enabled with `JEV_API_KEY`, selects a Sol, Luna or permitted Astra model and effort profile for every role, including reviewers; `allowAstra` is enabled by default and configurable through `/config` or `/plugin`; Fast mode is off by default and chosen per dispatch or with the `fast` option; `/codex-team:using-codex-team` makes the session their tech lead. |
| [git-master](plugins/git-master/README.md) | Registers git-master, a Haiku subagent for git work (status, branches, commits, rebase, push, pull and merge requests) that the session calls whenever a request is about git. |
| [gitlab](plugins/gitlab/README.md) | Opens, edits, comments on, reviews and (when asked, behind guards) merges GitLab merge requests, lists yours across projects, manages labels and runs and reads pipelines, jobs, artifacts and job errors, picking the host (gitlab.com or self-managed) and its token from the git remote. |
| [session-hud](plugins/session-hud/README.md) | A three-row card above the prompt: model, context, cache and cost; the five-hour and seven-day limits with their pace; the last turn, edits and errors. |
| [spider-team](plugins/spider-team/README.md) | Native Spider Team specialists with Jev model and effort routing. |
| [tailscale](plugins/tailscale/README.md) | Lets Claude query and modify your tailnet through the Tailscale API, with the key in the sensitive `apiKey` plugin option. |

## Install

Inside Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install chatgpt@spider-claude-mods
/plugin install codex-computer-use@spider-claude-mods
/plugin install codex-team@spider-claude-mods
/plugin install git-master@spider-claude-mods
/plugin install gitlab@spider-claude-mods
/plugin install session-hud@spider-claude-mods
/plugin install spider-team@spider-claude-mods
/plugin install tailscale@spider-claude-mods
```

### One step on a Mac

`scripts/bootstrap.sh` adds the marketplace, installs or updates chatgpt, codex-computer-use and tailscale, and installs the codex-computer-use helper (a LaunchAgent) from the installed plugin. The repository is private, so the command borrows the token of `gh`:

```
curl -fsSL -H "Authorization: Bearer $(gh auth token)" -H 'Accept: application/vnd.github.raw' \
  https://api.github.com/repos/anderson-spider/claude-mods/contents/scripts/bootstrap.sh | sh
```

Add `-s -- --check` after `sh` to see what it would do, or `-s -- --only tailscale,chatgpt` to limit the plugins. It is safe to run again. The helper is skipped with a reason if the ChatGPT app is missing. It never sets the secret `apiKey` option: use `claude plugin configure tailscale`.

To use a local copy instead of GitHub, pass the folder path:

```
/plugin marketplace add ~/dev/personal/claude-mods
```

The plugins here are function hooks mods, a Claude Code API still in early access that may change between versions.

Requires Claude Code v2.1.287 or later, the first version that runs mods without an opt-in flag ([mods overview](https://code.claude.com/docs/en/plugins/mods)); tailscale's sensitive `apiKey` is a `userConfig` option, for which no separate minimum was found beyond that floor. The repository is checked with v2.1.296 (`claude --version`). The mods reference marks host calls that need a later version; the plugins have not been audited against those marks.

See [Privacy and permissions](docs/PRIVACY.md) for what each plugin reads and saves, and [Verification](docs/VERIFICATION.md) for what the tests cover and what they do not.

Plugin READMEs cover setup, privacy and validation. [Privacy](docs/PRIVACY.md) and [Verification](docs/VERIFICATION.md) hold repository-wide notes.

## Development

To edit a plugin with automatic reload, point Claude Code straight at its folder, with `claude --plugin-dir` or in the `env` of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/plugins/<name>"
  }
}
```

To validate and test:

```
claude plugin validate --strict .
claude plugin validate --strict plugins/session-hud
claude plugin test plugins/session-hud
```

For the other plugins' checks, see their READMEs in the [plugins table](#plugins).

To start a plugin, run `mise run plugin:new <name> [description]`: it writes the plugin folder, its marketplace entry, rule file and README rows, and generates the typings. `mise run plugins:types [name]` regenerates them for one plugin or all.

To bring an installation up to date in one go, run `mise run update:all` from the main checkout. It refuses a worktree or a dirty tree, pulls `main` with `--ff-only`, runs `mise run plugins:update` and prints the installed versions. Run `/reload-plugins` afterwards, or start a new session.

`/reload-plugins` and `claude plugin details` count only `hooks.json` command hooks, so they report `0 hooks` for every plugin here: each one ships a hooks module (`{ "modules": [...] }`), which those counts leave out. To see what a module hooks, run `claude plugin validate plugins/<name>`, which lists its events and `$` calls (`> ./register.tsx hooks: session.start, tool.call{tool=Agent}` for spider-team). In a session, the session-hud card above the prompt shows that modules loaded; a module that failed to load leaves a line in `claude --debug`.
