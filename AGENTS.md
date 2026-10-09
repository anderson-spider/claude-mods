# AGENTS.md

Claude Code plugin marketplace `spider-claude-mods` (`anderson-spider/claude-mods`) with six plugins, all **function hooks mods** (an early-access Claude Code API that may change between versions). The `claude-code` module (`atom`, `read`, `Register`, `claude-code/testing`) is not on npm: Claude Code writes its typings to `plugins/*/.claude-plugin/types/` when it loads a plugin (git-ignored), and each plugin's `tsconfig.json` extends them. There is no `package.json`, build or lint. IMPORTANT: load the `plugin-authoring` skill before writing or debugging a hooks module.

## Layout

- `.claude-plugin/marketplace.json` lists the plugins; each lives in `plugins/<name>/` with `.claude-plugin/plugin.json`, `hooks/` (`hooks.json` only points to the entry module), `tests/` and (except hud, which is plain ESM) `types/index.d.ts`. codex-computer-use also has `helper/`.
- The entry module (`register.tsx`, `hud.mjs` for hud) holds `register`, every `on(...)` and every literal `$.noun.method(...)` call; the engine reads them from source. Pure modules take host access injected and never touch `$`. Tests mirror the modules.
- Tools are listed as `mcp__<plugin>__<name>`; their inputs are declared in `types/index.d.ts` for the matchers and must follow the `inputSchema`.

## Plugins

Each plugin's details live in `plugins/<name>/AGENTS.md`, loaded when working under that directory (its `CLAUDE.md` imports it).

- **branch-guard**: holds a commit or push on a protected branch until the person proceeds or cancels.
- **chatgpt**: `ask` and `image` tools driving chatgpt.com in the first browser that works.
- **codex-computer-use**: routes native Mac app control through Codex computer use; has a `helper/` run by the ChatGPT app's `node`.
- **tailscale**: `tailscale_get` and `tailscale_write` tools over the Tailscale API.
- **hud**: rows above the prompt plus suggested next prompts; plain ESM, adapted from third-party work (keep `LICENSE` and `NOTICE`).
- **pantheon**: orchestrator mode with profiles, Codex/Claude roles, council seats and the Agents/Jobs panel; includes third-party work (keep `LICENSE` and `NOTICE`).

## Commands

```
claude plugin validate .                       # validates the marketplace
claude plugin validate plugins/branch-guard    # validates the plugin
claude plugin test plugins/branch-guard        # runs tests/*.test.ts
claude plugin test plugins/chatgpt             # same, for chatgpt
claude plugin test plugins/codex-computer-use  # same, for codex-computer-use (the plugin side)
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs   # its helper
claude plugin test plugins/tailscale           # same, for tailscale
claude plugin test plugins/hud                 # same, for hud
claude plugin test plugins/pantheon            # same, for pantheon
node scripts/check-consistency.mjs             # marketplace and plugin manifests agree (also run by CI)
node scripts/check-version-bump.mjs origin/main  # a plugin with code changes bumped its version (run by CI on pull requests)
claude --plugin-dir plugins/branch-guard       # loads the plugin with automatic reload
make validate                                  # validates the marketplace and every plugin, then runs check-consistency
make test                                      # runs every plugin's tests and the codex-computer-use helper's
make update                                    # refreshes the marketplace and updates every installed plugin from it
```

Inside a session, `/reload-plugins` reloads the hooks.

## Conventions

- README, docs, code comments and user-facing messages are in English.
- When a plugin's behavior changes, bump `version` in its `plugin.json`.
- Done for a plugin change means: `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>` pass, `node scripts/check-consistency.mjs` passes, `version` is bumped if behavior changed, and README/AGENTS.md match the new behavior.
- PR titles follow Conventional Commits in English and descriptions are in English (`.github/pull_request_template.md`).
- History belongs in git; invariants that explain one line of code live as a comment there.
