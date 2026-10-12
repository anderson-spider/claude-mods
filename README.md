# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in a folder under `plugins/` and is listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [chatgpt](plugins/chatgpt/README.md) | Lets Claude ask your logged-in ChatGPT, or have it generate an image, in terminal-browser, Claude in Chrome or the Claude desktop app's built-in browser, and saves the result locally. |
| [codex-computer-use](plugins/codex-computer-use/README.md) | Routes native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [crew](plugins/crew) | Registers five specialist subagents: `code-reader` and `research` on Haiku; `designer` and `developer` on Sonnet; `architect` on Opus. `jevKey` enables Jev effort routing. A gateway as `ANTHROPIC_BASE_URL` (such as Tailscale Aperture routing Codex models to an OmniRoute) enables fixed-model Codex twins; the `mode` option and `/crew-mode` switch plain calls to those twins (`codex`) or keep them on Claude (`claude`, the default), so calls may go to OpenAI with or without Jev. The experimental `codexLogin` option runs the code-reader twin on your Codex CLI login with no gateway. No HUD or panel command. |
| [tailscale](plugins/tailscale/README.md) | Lets Claude query and modify your tailnet through the Tailscale API. |

## Install

Inside Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install chatgpt@spider-claude-mods
/plugin install codex-computer-use@spider-claude-mods
/plugin install crew@spider-claude-mods
/plugin install tailscale@spider-claude-mods
```

To use a local copy instead of GitHub, pass the folder path:

```
/plugin marketplace add ~/dev/personal/claude-mods
```

The plugins here are function hooks mods, a Claude Code API still in early access that may change between versions.

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
claude plugin validate .
claude plugin validate plugins/crew
claude plugin test plugins/crew
```

For the other plugins' checks, see their READMEs in the [plugins table](#plugins).

To bring an installation up to date in one go, run `mise run update:all` from the main checkout. It refuses a worktree or a dirty tree, pulls `main` with `--ff-only`, runs `mise run plugins:update` and prints the installed versions. Run `/reload-plugins` afterwards, or start a new session for crew twins.
