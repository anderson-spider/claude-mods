# AGENTS.md

Claude Code plugin marketplace `spider-claude-mods` (`anderson-spider/claude-mods`) with five plugins, all **function hooks mods** (an early-access Claude Code API that may change between versions). The `claude-code` module (`atom`, `read`, `Register`, `claude-code/testing`) is not on npm: Claude Code writes its typings to `plugins/*/.claude-plugin/types/` when it loads a plugin (git-ignored), and each plugin's `tsconfig.json` extends them. There is no `package.json`, build or lint. IMPORTANT: load the `plugin-authoring` skill before writing or debugging a hooks module.

## Layout

- `.claude-plugin/marketplace.json` lists the plugins; each lives in `plugins/<name>/` with `.claude-plugin/plugin.json`, `hooks/` (`hooks.json` only points to the entry module), `tests/` and `types/index.d.ts`. codex-computer-use also has `helper/`.
- The entry module (`register.tsx`) holds `register`, every `on(...)` and every literal `$.noun.method(...)` call; the engine reads them from source. Pure modules take host access injected and never touch `$`. Tests mirror the modules.
- Tools are listed as `mcp__<plugin>__<name>`; their inputs are declared in `types/index.d.ts` for the matchers and must follow the `inputSchema`.

## Plugins

Each plugin's details live in `plugins/<name>/AGENTS.md`, loaded when working under that directory (its `CLAUDE.md` imports it).

- **branch-guard**: holds a commit or push on a protected branch until the person proceeds or cancels.
- **chatgpt**: `ask` and `image` tools driving chatgpt.com in the first browser that works.
- **codex-computer-use**: routes native Mac app control through Codex computer use; has a `helper/` run by the ChatGPT app's `node`.
- **tailscale**: `tailscale_get` and `tailscale_write` tools over the Tailscale API.
- **pantheon**: lead mode with native Claude roles, council seats, the JevFlow flow (claims by role), the agents and flow panel and the above-prompt strip (absorbed from the former hud plugin); includes third-party work (keep `LICENSE`, `LICENSE-APACHE` and `NOTICE`).

## Commands

```
mise install                                   # node and TypeScript 7 from mise.toml (scripts, `tsc --lsp`, `tsc -p plugins/<name>/tsconfig.json`)
mise run plugins:types                         # writes every plugin's .claude-plugin/types/ (a short interactive session loads each plugin from its folder)
claude plugin validate .                       # validates the marketplace
claude plugin validate plugins/branch-guard    # validates the plugin
claude plugin test plugins/branch-guard        # runs tests/*.test.ts
claude plugin test plugins/chatgpt             # same, for chatgpt
claude plugin test plugins/codex-computer-use  # same, for codex-computer-use (the plugin side)
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs   # its helper
claude plugin test plugins/tailscale           # same, for tailscale
claude plugin test plugins/pantheon            # same, for pantheon
node scripts/check-consistency.mjs             # marketplace and plugin manifests agree (also run by CI)
node scripts/check-version-bump.mjs origin/main  # a plugin with code changes bumped its version (run by CI on pull requests)
claude --plugin-dir plugins/branch-guard       # loads the plugin with automatic reload
mise run plugins:validate                      # validates the marketplace and every plugin, then runs check-consistency
mise run plugins:test                          # runs every plugin's tests and the codex-computer-use helper's
mise run plugins:update                        # refreshes the marketplace and updates every installed plugin from it
```

Inside a session, `/reload-plugins` reloads the hooks.

## Conventions

- README, docs, code comments and user-facing messages in the plugins (labels, toasts, errors) are in English.
- When a plugin's behavior changes, bump `version` in its `plugin.json`.
- Done for a plugin change means: `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>` pass, `node scripts/check-consistency.mjs` passes, `version` is bumped if behavior changed, and README/AGENTS.md match the new behavior.
- PR titles follow Conventional Commits in English and descriptions are in English (`.github/pull_request_template.md`).
- History belongs in git; invariants that explain one line of code live as a comment there.
