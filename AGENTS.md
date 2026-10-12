# AGENTS.md

Claude Code plugin marketplace `spider-claude-mods` (`anderson-spider/claude-mods`) with five plugins, all **function hooks mods** (an early-access Claude Code API that may change between versions). The `claude-code` module (`atom`, `read`, `Register`, `claude-code/testing`) is not on npm: Claude Code writes its typings to `plugins/*/.claude-plugin/types/` when it loads a plugin (git-ignored), and each plugin's `tsconfig.json` extends them. There is no `package.json`, build or lint. IMPORTANT: load the `plugin-authoring` skill before writing or debugging a hooks module.

## Layout

- `.claude-plugin/marketplace.json` lists the plugins; each lives in `plugins/<name>/` with `.claude-plugin/plugin.json`, `hooks/` (`hooks.json` only points to the entry module), `tests/` and `types/index.d.ts`. codex-computer-use also has `helper/`.
- A plugin has one hooks module (`register.tsx`); `validate` refuses a second entry in `hooks.json`. The engine reads the `on(...)` and `$.noun.method(...)` calls from source and follows imports, but `$` is passed only to a function declared at the top of the same file, never across an import. The entry module holds `register` and its hooks; it may call a vendored `registerX(on, options)` from a subfolder whose file holds its own `on(...)` and `$` calls (crew's `hooks/flightdeck/`). Pure modules take host access injected and never touch `$`. Tests mirror the modules.
- Tools are listed as `mcp__<plugin>__<name>`; their inputs are declared in `types/index.d.ts` for the matchers and must follow the `inputSchema`.
- `.claude/` holds this repository's own session setup: the `release-plugin` skill (`/release-plugin <plugin>` runs the done checklist below), the `live-test` skill (`/live-test <plugin>` opens a Herdr pane on the right with `claude --plugin-dir plugins/<plugin>`, drives it, audits the result against the docs and closes the pane), the `ship` skill (`/ship` takes the branch from checklist to approved merge and plugin update), the `cleanup` skill (`/cleanup` prunes merged branches and worktrees after one approval) and two hooks in `.claude/hooks/` (block edits to the generated `.claude-plugin/types/`, not the hand-written `types/index.d.ts`; type-check the plugin owning an edited `.ts`/`.tsx` once its typings exist).

## Plugins

Each plugin's details live in `plugins/<name>/AGENTS.md`, loaded when Claude reads or edits a file under that directory (`.claude/rules/<name>.md` imports it; a `CLAUDE.md` at a plugin root draws a `claude plugin validate` warning).

- **branch-guard**: holds a commit or push on a protected branch until the person proceeds or cancels.
- **chatgpt**: `ask` and `image` tools driving chatgpt.com in the first browser that works.
- **codex-computer-use**: routes native Mac app control through Codex computer use; has a `helper/` run by the ChatGPT app's `node`.
- **crew**: registers the `code-reader`, `research`, `designer`, `developer`, `tester` and `architect` subagent types with default models; Jev routing, on when the `jevKey` option is set, moves a call's model and effort one step; carries the vendored Flightdeck dashboard (`hooks/flightdeck/`, MIT, with its `LICENSE` and `NOTICE.md`); with the `codex` option on, the lead can run any role on OpenAI Codex (`mcp__crew__codex`); with `nativeCodex` and a loopback proxy, `crew:<role>-codex` twins run a role on a Codex model.
- **tailscale**: `tailscale_get` and `tailscale_write` tools over the Tailscale API.

## Commands

```
mise install                                   # node and TypeScript 7 from mise.toml (scripts, `tsc --lsp`, `tsc -p plugins/<name>/tsconfig.json`)
mise run plugins:types                         # writes every plugin's .claude-plugin/types/ (a short interactive session loads each plugin from its folder)
claude plugin validate .                       # validates the marketplace
claude plugin validate plugins/<name>          # validates the plugin
claude plugin test plugins/<name>              # runs the plugin's tests/*.test.ts
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs   # the codex-computer-use helper's tests
node scripts/check-consistency.mjs             # marketplace and plugin manifests agree (also run by CI)
node scripts/check-version-bump.mjs origin/main  # a plugin with code changes bumped its version (run by CI on pull requests)
claude --plugin-dir plugins/<name>             # loads the plugin with automatic reload
mise run plugins:validate                      # validates the marketplace and every plugin, then runs check-consistency
mise run plugins:test                          # runs every plugin's tests and the codex-computer-use helper's
mise run plugins:update                        # refreshes the marketplace and updates every installed plugin from it
```

Inside a session, `/reload-plugins` reloads the hooks.

## Conventions

- README, docs, code comments and user-facing messages in the plugins (labels, toasts, errors) are in English.
- When a plugin's behavior changes, bump `version` in its `plugin.json`.
- Done for a plugin change means: `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>` pass, `node scripts/check-consistency.mjs` passes, `version` is bumped if behavior changed, and the root README and the plugin's AGENTS.md match the new behavior.
- PR titles follow Conventional Commits in English and descriptions are in English (`.github/pull_request_template.md`).
- History belongs in git; invariants that explain one line of code live as a comment there.
