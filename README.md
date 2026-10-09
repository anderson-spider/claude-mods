# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in a folder under `plugins/` and is listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [branch-guard](plugins/branch-guard) | Holds a `git commit` or `git push` on the protected branch and shows what would go in. |
| [chatgpt](plugins/chatgpt) | Lets Claude ask your logged-in ChatGPT, or have it generate an image, in terminal-browser, Claude in Chrome or the Claude desktop app's built-in browser, and saves the result locally. |
| [codex-computer-use](plugins/codex-computer-use) | Routes native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [tailscale](plugins/tailscale) | Lets Claude query and modify your tailnet through the Tailscale API. |
| [hud](plugins/hud) | One line above the prompt (context, 5-hour and 7-day limits against the clock, the prompt cache, the subagents running) and suggested next prompts you can write directly to the prompt box as a draft. |
| [pantheon](plugins/pantheon) | Makes Claude an orchestrator that delegates to Codex roles (explorer, librarian, fixer) and native Claude agents (oracle, designer, council), with an auto-opening `/pantheon` panel for roles, activity and a session log. |

## Install

Inside Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install branch-guard@spider-claude-mods
/plugin install chatgpt@spider-claude-mods
/plugin install codex-computer-use@spider-claude-mods
/plugin install tailscale@spider-claude-mods
/plugin install hud@spider-claude-mods
/plugin install pantheon@spider-claude-mods
```

To use a local copy instead of GitHub, pass the folder path:

```
/plugin marketplace add ~/dev/personal/claude-mods
```

The plugins here are function hooks mods, a Claude Code API still in early access that may change between versions.

See [Privacy and permissions](docs/PRIVACY.md) for what each plugin reads and saves, and [Verification](docs/VERIFICATION.md) for what the tests cover and what they do not.

## branch-guard

When Claude calls Bash with `git commit` or `git push` and the target branch is `main`, `master`, `develop`, `release` or `release/*` (also `release-*` and `release_*`), Branch Guard holds the call and shows in the band above the prompt what would go in: the commit's files or the commits that would be pushed, in the same band layout (`Command`, `Would`, `… and N more`, `Proceed` on key `1`, `Cancel` on key `2`). On cancel, Claude gets the refusal with guidance to open a working branch (`git switch -c`) and redo the command there, or to open a PR when the push is `HEAD:<protected>` from another branch.

Passes without asking: commits and pushes on other branches, on a detached HEAD, in a repository inside `/tmp`, `git commit --dry-run`, `git push --dry-run`, tag-only pushes and commits with nothing staged. Force push is not handled here. To turn the warning off, disable only this plugin.

Limitations: the plugin reads the command text, so `merge`, `cherry-pick`, `rebase`, `pull`, aliases and `bash -c "git commit"` do not go through it; a stray `"` or `'` in the body of a `-m "$(cat <<EOF …)"` can confuse the parsing; it only sees what Claude types, not your terminal.

## chatgpt

Sends a self-contained question to your own ChatGPT, already logged in at chatgpt.com in the browser the plugin finds, waits for the answer and saves it as Markdown; it can also have ChatGPT generate or edit an image, optionally from a local reference, and save it. It saves Claude's tokens when the question needs little context and the answer is long (research, explanations, drafts, translations, a second opinion); for work that needs the repository it does not pay off, since the context would go out and the answer would come back anyway. The plugin adds a section to Claude's system prompt so it asks ChatGPT on its own in those cases, saying so in one line first; images still need your request.

The plugin picks the first browser that works, in this order: [terminal-browser](https://terminal-browser.sh) when Claude Code runs in a terminal pane it supports (Ghostty, kitty), where it opens its own tab with `terminal-browser new-tab`; then Claude in Chrome (the `mcp__claude-in-chrome__*` tools, in your real Chrome, so log in to chatgpt.com there); then the Claude desktop app's built-in browser (the `mcp__Claude_Browser__*` tools, with its own sign-ins, so log in to chatgpt.com in that pane). `/chatgpt-doctor` names the one it uses. Attachments and reference images work with each of them: the plugin puts the file on the page's file input with a script, so the page must show one (`/chatgpt-doctor` checks it).

| Entry | What it does |
| --- | --- |
| `mcp__chatgpt__ask` | Tool for Claude: `prompt` (required), `chatUrl` (the chat link a previous call returned, to continue that chat), `model` (a model menu entry, by the start of its label), `files` (absolute paths to attach), `wait` (`false` runs it in the background), `saveOnly` (with `chatUrl`: save the last answer, waiting while it streams), `out` and `maxChars` (how much of the answer comes back inline, default 3000). |
| `mcp__chatgpt__image` | Tool for Claude: `prompt` (required), `reference` (an image of at most 4 MiB to attach), and the same `chatUrl`, `model`, `files`, `wait`, `saveOnly` and `out`. Saves every variant ChatGPT draws and returns their paths, sizes, the chat link and a preview of each; when ChatGPT answers with text instead (a refusal or a question), returns that text. |
| `mcp__chatgpt__jobs` | Tool for Claude: the requests that ran or run in the background, with their status, chat link and files. |
| `/chatgpt-ask <question>` | Asks from the prompt and shows the whole answer. |
| `/chatgpt-image <prompt>` | Generates an image from the prompt and saves it. |
| `/chatgpt-doctor [chat link]` | Opens ChatGPT and reports which page parts the plugin relies on are where it expects them (login, composer, file inputs, model menu, and with a chat link the answers, images and code blocks). |

Every request starts a new chat (the home page is one), unless a `chatUrl` brings Claude back to an earlier one. The plugin works in a tab of its own, kept across requests, and never touches another tab; requests take turns there. A request still going after 6 minutes moves to the background (up to 30), and a message arrives in the conversation when it is saved; `wait: false` does that from the start. When the page shows a usage limit, a human verification or another blocking dialog, the plugin stops and quotes it.

The answer goes to `$TMPDIR/chatgpt/<date>-<subject>.md`, with the chat URL on the first line; Claude gets the path, the URL and the start of the answer, and reads the rest from the file when it needs it. Code blocks keep their language, and lists, tables, quotes and math come back as Markdown. The tool's description tells Claude not to send credentials, secrets, private personal data or work data, and to treat the answer as ChatGPT's unverified opinion.

Images go to `$TMPDIR/chatgpt/<date>-<subject>.png` (or the type ChatGPT served, with `-1`, `-2` for variants), decoded with `openssl`; the preview is a 768 px JPEG made with `sips`. Image tools spend your ChatGPT image quota, so Claude is told to use them only when you ask for an image, to attach only references you asked for or that it made for the task, and to label the result as an AI concept.

Requirements:

- One of: terminal-browser, with Claude Code running directly in a Ghostty or kitty pane (not inside tmux, Herdr or a background session); Claude in Chrome, with chatgpt.com logged in in Chrome; or the Claude desktop app's built-in browser, with chatgpt.com logged in in its pane. Logged in to chatgpt.com in that browser. The plugin never types credentials: when the page asks for a login, it stops and says so.
- Nothing else for permissions, in any mode, auto mode included: terminal-browser runs as a process, not as tool calls, and the plugin allows its own Claude in Chrome and built-in browser calls that stay on chatgpt.com (listing and opening tabs, going to chatgpt.com, scripts in its own tab). Add `mcp__chatgpt__*` to `permissions.allow` in `~/.claude/settings.json` to skip the prompt for the tools themselves.

Limitations: it reads chatgpt.com's page, so a change in ChatGPT's interface can break sending or reading until the selectors in `hooks/scripts.ts` are updated (`/chatgpt-doctor` says which); a generated image is recognised by its alt text ("Imagem 1 gerada", "Generated image 1"); background jobs live in the session and are lost on a plugin reload.

## codex-computer-use

Lets Claude control native Mac apps (Calculator, TextEdit, Finder…) through Codex computer use, the engine bundled with the ChatGPT desktop app, which clicks and types inside apps in the background without taking over the mouse. Claude still decides what to do; Codex carries out the clicks and typing.

It has three pieces:

| Piece | What it does |
| --- | --- |
| `helper/launch.mjs` (the `codex-cu` connection) | Reads `mcpServers.cua_repl` from the newest `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json` and starts it with the desktop surface only, so a ChatGPT update needs no edit (a protocol change can still break it). `--check` lists what it would start, without env values. |
| `helper/helper.mjs` (LaunchAgent `com.anderson-spider.codex-cu`) | MCP client of that connection, served on `~/.claude/mcp/codex-cu/run/helper.sock` (directory `0700`, socket `0600`). One Codex session per caller (a Claude session, or `<session>/<agent>` for a subagent), calls serialized per caller, app approvals answered only from your choices, an app owned by one caller until 2 minutes after its last call, at most 8 Codex sessions (the quietest idle one makes room), 15 minutes idle expiry. |
| the plugin | The `mcp__codex-computer-use__codex_cu` tool, the approval band, the `/codex-cu` command, a system-prompt section on how to drive the API, and a block on Claude's own desktop computer-use tools (`mcp__computer-use__*`, `mcp__remote-devices__computer*`) while on. Browsers, CLIs and purpose-built tools stay available. |

The first use of an app asks in a band above the prompt: `This session` (key `1`), `Always` (key `2`, also saved in Codex's own `ComputerUseAppApprovals.json`) or `No` (key `3`). A `No` is kept for that caller and the call is refused without asking again; organization and safety blocks from Codex pass through as they are. The first call of a new or reset Codex session must be one documented entry call (`await cua.getState();` or `let app = await cua.getApp("Calculator");`), whose result carries the API documentation.

```
/codex-cu on | off | status
/codex-cu forget            drop this session's answers (This session / No)
/codex-cu forget <app>      take <app> off "always allow" in the helper and in Codex
/codex-cu auto-approve on | off
```

Requirements: macOS, the ChatGPT desktop app with Computer Use turned on in Codex (`/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node` and the `.mcp.json` above). After installing the plugin, install the helper once from a clone:

```
plugins/codex-computer-use/helper/install.sh
```

It copies the helper to `~/.claude/mcp/codex-cu` (keeping `state/`, where the approvals and the log live) and loads the LaunchAgent; run it again after a helper change. `uninstall.sh` removes the LaunchAgent and leaves the files. To load the plugin from the folder instead of the marketplace, pass `--plugin-dir plugins/codex-computer-use`, which adds it to `CLAUDE_CODE_PLUGIN_DIRS`.

Limitations: ownership is checked for apps named as string literals in `cua.getApp(...)` and for the app each result reports, so an app reached through a variable is owned only after its first call; Codex refuses an action when the app changed since it was last read ("The user changed …"), so read and act in the same call.

## tailscale

Registers two tools for Claude to talk to the Tailscale API (`https://api.tailscale.com/api/v2`), authenticated by the `TS_API_KEY` environment variable, which must be exported when Claude Code starts:

| Tool | What it does |
| --- | --- |
| `mcp__tailscale__tailscale_get` | Read-only (`GET`): devices, ACL, DNS, keys, users, invites, settings, webhooks, logs, device posture, services, OAuth apps and contacts. E.g. `/tailnet/-/devices`. Accepts `fields` to return only the requested keys (the API does not paginate, so the whole list comes back). Strips `machineKey`, `nodeKey`, `tailnetLockKey`, `secret`, `s3SecretAccessKey` and `token` from the response and shows the `ETag` when there is one. |
| `mcp__tailscale__tailscale_write` | Modifies the tailnet (`POST`, `PUT`, `PATCH`, `DELETE`): tags, routes, ACL, DNS, deleting devices, keys, webhooks. Accepts `ifMatch`. The response comes back complete, because the API shows a new key's secret only once. |

They are separate so you can allow read-only without a prompt and keep write asking for confirmation. The `path` must be relative to the API and start with `/`; `//host`, `..`, `%2e`, `%2f`, `%5c` and full URLs are rejected. A `-` in place of the tailnet means the default one.

To update the ACL without overwriting someone else's edit: do a `GET /tailnet/-/acl`, keep the response's `ETag` and pass it in `ifMatch` on the `POST /tailnet/-/acl` (the API responds 412 if the ACL changed). A string `body` that is not valid JSON is sent as HuJSON, so a policy with comments works. `DELETE /tailnet/{tailnet}`, which deletes the whole tailnet, is refused by the tool.

`TS_API_KEY` must be a `tskey-api-...` key. An OAuth secret `tskey-client-...` is not valid as a Bearer without a token exchange, which the plugin does not do.

## hud

One line above the prompt, an info line above it (model, effort, speed, folder, branch and changed files) and suggested next prompts above that. The usage line: the context with a weather icon, one bar per recent prompt and the last prompt's change; the 5-hour and 7-day limits as block bars with a mark against the clock (`▲` ahead, `▼` behind, no mark on pace) and the time left; the prompt cache with its time left, yellow near the end and red once expired; and the subagents running. After each answer, up to three likely next prompts: press `1`, `2` or `3` to write that suggestion directly to the prompt box as a draft; the plugin never sends it. Options (`/plugin`): **Pace start**, **Shortest answer to suggest after** and **Suggest skills and slash commands**. It was `token-weather-usage` before 1.0.0 and is built on Token Weather Usage (Eric Cologni, Apache-2.0) and next-steps (Thariq Shihipar, MIT), among others. See [its README](plugins/hud/README.md) and its [NOTICE](plugins/hud/NOTICE).

## pantheon

The main session delegates to Codex specialists through `delegate` and to native Claude agents through the Agent tool. The `/pantheon` panel opens by itself at session start; `/pantheon` opens or focuses it and `/pantheon close` closes it. The panel keeps seven role slots in order: orchestrator, explorer, librarian, fixer, oracle, designer and council. Parallel instances stack in their role, resumed work shows its rounds, and other subagents appear under "other agents" when present. Each instance shows its model, elapsed time, context percentage and last activity; tokens are in the Session card. A running Codex row has a Cancel button.

The panel docks beside the terminal transcript, uses a mini view when placed inline, and adds a "Last 15 minutes" SVG timeline on desktop. Each section is a card with its own colored border, and an animated rail (110 ms) runs only while there is active work. The docked layout has rails, clocks and the pulse; mini (placed inline) has clocks and the pulse, no rails; desktop has rails and clocks, no pulse. It has no panel configuration; rate limits, repository, branch and cache stay in hud. Its tracking hooks only watch and pass events on unchanged. `/pantheon cancel <jobId>`, `/pantheon config` and `/pantheon doctor` keep their existing behavior. See [its README](plugins/pantheon/README.md) and [NOTICE](plugins/pantheon/NOTICE).

flightdeck users: `/plugin uninstall flightdeck`.

## Development

To edit a plugin with automatic reload, point Claude Code straight at its folder, with `claude --plugin-dir` or in the `env` of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/plugins/branch-guard"
  }
}
```

To validate and test:

```
claude plugin validate .
claude plugin validate plugins/branch-guard
claude plugin test plugins/branch-guard
claude plugin validate plugins/chatgpt
claude plugin test plugins/chatgpt
claude plugin validate plugins/codex-computer-use
claude plugin test plugins/codex-computer-use
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs
claude plugin validate plugins/tailscale
claude plugin test plugins/tailscale
```
