# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in a folder under `plugins/` and is listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [chatgpt](plugins/chatgpt/README.md) | Lets Claude ask your logged-in ChatGPT, or have it generate an image, in terminal-browser, Claude in Chrome or the Claude desktop app's built-in browser, and saves the result locally. |
| [codex-computer-use](plugins/codex-computer-use/README.md) | Routes native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [codex-team](plugins/codex-team/README.md) | Dispatches Codex developers, analysts, architects and reviewers into Herdr task tabs with delivery status and short reports; publishes the active crew plan to Dagr. Optional Jev assessment selects effort using `JEV_API_KEY`; `/codex-team:using-codex-team` makes the session their tech lead. |
| [crew](plugins/crew) | The main session implements; crew adds three optional read-only helpers: `planner` and `challenger` on Opus, `digger` on Haiku, all at high effort, and no task requires one. `jevKey` enables Jev effort routing. Each helper has a fixed-model Codex twin, served by a gateway as `ANTHROPIC_BASE_URL` or, with the experimental `codexLogin` option, by your Codex CLI login (the three twins through the crew Codex helper, in Codex's read-only sandbox, when it is installed and running; the planner and challenger twins fall back to the backend without it); the `mode` option and `/crew-mode` switch plain calls to those twins (`codex`) or keep them on Claude (`claude`, the default), so calls may go to OpenAI with or without Jev. /crew-hud opens a pane with each plan as a tree and each helper's activity, in the design's colours under a dark or automatic theme. |
| [git-master](plugins/git-master/README.md) | Registers git-master, a Haiku subagent for git work (status, branches, commits, rebase, push, pull and merge requests) that the session calls whenever a request is about git. |
| [session-hud](plugins/session-hud/README.md) | A three-row card above the prompt: model, context, cache and cost; the five-hour and seven-day limits with their pace; the last turn, edits, errors and the crew's agents and plan. Requires crew, which no longer draws above the prompt. |
| [tailscale](plugins/tailscale/README.md) | Lets Claude query and modify your tailnet through the Tailscale API, with the key in the sensitive `apiKey` plugin option. |

## Install

Inside Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install chatgpt@spider-claude-mods
/plugin install codex-computer-use@spider-claude-mods
/plugin install codex-team@spider-claude-mods
/plugin install crew@spider-claude-mods
/plugin install git-master@spider-claude-mods
/plugin install session-hud@spider-claude-mods
/plugin install tailscale@spider-claude-mods
```

### One step on a Mac

`scripts/bootstrap.sh` adds the marketplace, installs or updates the four plugins and installs the crew and codex-computer-use helpers (LaunchAgents) from the installed plugins. The repository is private, so the command borrows the token of `gh`:

```
curl -fsSL -H "Authorization: Bearer $(gh auth token)" -H 'Accept: application/vnd.github.raw' \
  https://api.github.com/repos/anderson-spider/claude-mods/contents/scripts/bootstrap.sh | sh
```

Add `-s -- --check` after `sh` to see what it would do, or `-s -- --only crew,chatgpt` to limit the plugins. It is safe to run again. A helper whose prerequisite is missing (the ChatGPT app, or the Codex CLI and its login for crew) is skipped with a reason. Secret options (`jevKey`, `apiKey`) are never set by it: use `claude plugin configure <plugin>`.

To use a local copy instead of GitHub, pass the folder path:

```
/plugin marketplace add ~/dev/personal/claude-mods
```

The plugins here are function hooks mods, a Claude Code API still in early access that may change between versions.

Requires Claude Code v2.1.287 or later, the first version that runs mods without an opt-in flag ([mods overview](https://code.claude.com/docs/en/plugins/mods)); crew's `mode` option uses `userConfig` `options`, which need v2.1.271 ([plugins reference](https://code.claude.com/docs/en/plugins-reference)), which that floor already covers; tailscale's sensitive `apiKey` is a `userConfig` option too, for which no separate minimum was found beyond that floor. The repository is checked with v2.1.296 (`claude --version`). The mods reference marks host calls that need a later version; the plugins have not been audited against those marks.

See [Privacy and permissions](docs/PRIVACY.md) for what each plugin reads and saves, and [Verification](docs/VERIFICATION.md) for what the tests cover and what they do not.

Plugin READMEs cover setup, privacy and validation. [Privacy](docs/PRIVACY.md) and [Verification](docs/VERIFICATION.md) hold repository-wide notes and the crew details.

## crew

Five specialist subagents, optional Jev sizing, fixed-model Codex twins and a claude/codex crew mode. See [the crew README](plugins/crew/README.md) for setup, delegation, privacy and verification.

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
claude plugin validate --strict plugins/crew
claude plugin test plugins/crew
```

For the other plugins' checks, see their READMEs in the [plugins table](#plugins).

To start a plugin, run `mise run plugin:new <name> [description]`: it writes the plugin folder, its marketplace entry, rule file and README rows, and generates the typings. `mise run plugins:types [name]` regenerates them for one plugin or all.

To bring an installation up to date in one go, run `mise run update:all` from the main checkout. It refuses a worktree or a dirty tree, pulls `main` with `--ff-only`, runs `mise run plugins:update` and prints the installed versions. Run `/reload-plugins` afterwards, or start a new session for crew twins.
