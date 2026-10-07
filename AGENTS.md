# AGENTS.md

Claude Code plugin marketplace `spider-claude-mods` (`anderson-spider/claude-mods`) with six plugins, all **function hooks mods** (an early-access Claude Code API that may change between versions). The `claude-code` module (`atom`, `read`, `Register`, `claude-code/testing`) is not on npm: Claude Code writes its typings to `plugins/*/.claude-plugin/types/` when it loads a plugin (git-ignored), and each plugin's `tsconfig.json` extends them. There is no `package.json`, build or lint. Load the `plugin-authoring` skill before writing or debugging a hooks module.

## Layout

- `.claude-plugin/marketplace.json` lists the plugins; each lives in `plugins/<name>/` with `.claude-plugin/plugin.json`, `hooks/` (`hooks.json` only points to the entry module), `tests/` and (except hud, which is plain ESM) `types/index.d.ts`. codex-computer-use also has `helper/`.
- The entry module (`register.tsx`, `hud.mjs` for hud) holds `register`, every `on(...)` and every literal `$.noun.method(...)` call; the engine reads them from source. Pure modules take host access injected and never touch `$`. Tests mirror the modules; `tests/helpers.ts` (codex-team) holds shared fakes.
- Tools are listed as `mcp__<plugin>__<name>`; their inputs are declared in `types/index.d.ts` for the matchers and must follow the `inputSchema`.

## Plugins

- **branch-guard**: holds a commit or push on a protected branch until the person proceeds or cancels (a band above the prompt). `classify.ts` reads the Bash text, `measure.ts` decides asynchronously whether the target is protected and what would go in (through an injected `Probe`), `shell.ts` parses shell text, `register.tsx` holds the call. A heredoc or here-string body is data, except when it is fed to a shell (`bash`, `sh`, `zsh`, `dash`, `ksh`, also through `sudo`/`env`/`ssh`, or by a pipe) with no `-c` or script, where it is parsed as commands. It is a safety net that reads text, not a permission system.
- **chatgpt**: `ask` and `image` tools, `jobs`, and `/chatgpt-ask`, `/chatgpt-image`, `/chatgpt-doctor`, driving chatgpt.com in terminal-browser (needs Claude Code directly in a Ghostty or kitty pane). `scripts.ts` holds every page script and shared selector; `terminal-browser.ts` adapts the CLI behind the injected `Browser`; `ask.ts`/`image.ts`/`conversation.ts` are the flows; `runner.ts` queues requests and runs background jobs; `output.ts` saves answers and images to `$TMPDIR/chatgpt/`. A `prompt.compose` section tells Claude to use `ask` unprompted.
- **codex-computer-use**: routes native Mac app control through Codex computer use, refusing Claude's own desktop tools while on. Two halves over a Unix socket: the plugin (`hooks/`) and `helper/` (plain Node ESM run by the ChatGPT app's `node`, installed by `helper/install.sh` as LaunchAgent `com.anderson-spider.codex-cu` into `~/.claude/mcp/codex-cu`). The helper is the MCP client of Codex's `cua_repl` server and answers its app-approval questions from the person's choices, because the plugin cannot answer an MCP elicitation. Helper: `hub.mjs` (sessions, ownership, approvals flow), `approvals.mjs` (policy), `codex-approvals.mjs` (Codex's saved list), `config.mjs`/`launch.mjs` (the connection). Plugin: `bridge.ts` runs the call/approval rounds, `routing.ts` and `presentation.ts` are pure text, `helper.ts` is the socket link. `/codex-cu` controls it.
- **codex-team**: `execute`, `review`, `loop`, `jobs` tools and `/codex-team`, `/codex-team-doctor`; Claude leads Codex agents in Herdr panes as background jobs. `job.ts` runs one phase, `loop.ts` alternates dev and QA rounds, `book.ts` owns ids, the execute queue and cancellation, `identity.ts`/`pane-layout.ts` guard and place panes, `herdr.ts` wraps the CLI, `prompts.ts`/`report.ts` define the agent instructions and the few report lines the plugin parses.
- **tailscale**: `tailscale_get` and `tailscale_write` tools over the Tailscale API. `api.ts` is pure (`call` takes an injected `fetch`); tests use only it, with a fake `fetch`.
- **hud**: a usage line above the prompt plus suggested next prompts; plain ESM with no `types/`. Adapted from third-party work: keep `LICENSE`, and list changes and credits in `NOTICE`. `hud.mjs` also reads the settings. Pure modules sit beside it (labels and palette, context, limits, cache, suggestions, info, drawing, `render.mjs` composing `AbovePrompt`); the flows `suggestion-flow.mjs`, `history.mjs` and `info-refresh.mjs` take only the host callbacks they use. Labels are English only.

## Commands

```
claude plugin validate .                       # validates the marketplace
claude plugin validate plugins/branch-guard    # validates the plugin
claude plugin test plugins/branch-guard        # runs tests/*.test.ts
claude plugin test plugins/chatgpt             # same, for chatgpt
claude plugin test plugins/codex-computer-use  # same, for codex-computer-use (the plugin side)
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs   # its helper
claude plugin test plugins/codex-team          # runs tests/*.test.ts; tests/helpers.ts holds shared fakes
claude plugin test plugins/tailscale           # same, for tailscale
claude plugin test plugins/hud                 # same, for hud
claude --plugin-dir plugins/branch-guard       # loads the plugin with automatic reload
```

Inside a session, `/reload-plugins` reloads the hooks.

## Conventions

- README, docs, code comments and user-facing messages are in English.
- When a plugin's behavior changes, bump `version` in its `plugin.json`.
- PR titles follow Conventional Commits in English and descriptions are in English (`.github/pull_request_template.md`).
- branch-guard's test fake host (`answer`) responds by executable and subcommand: a new git command the plugin measures needs an answer there.
- History belongs in git; invariants that explain one line of code live as a comment there.
