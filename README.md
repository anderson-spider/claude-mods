# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in a folder under `plugins/` and is listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [chatgpt](plugins/chatgpt) | Lets Claude ask your logged-in ChatGPT, or have it generate an image, in terminal-browser, Claude in Chrome or the Claude desktop app's built-in browser, and saves the result locally. |
| [codex-computer-use](plugins/codex-computer-use) | Routes native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [codex-models](plugins/codex-models) | Offers OpenAI Codex models (ChatGPT login) in Claude Code through a local loopback proxy, in `/model` and in agent definitions; Claude models pass through to Anthropic unchanged. |
| [crew](plugins/crew) | Registers five specialist subagents: `code-reader` and `research` on Haiku; `designer` and `developer` on Sonnet; `architect` on Opus. `jevKey` is the only option, enabling Jev model and effort routing. A local HTTP loopback proxy enables fixed-model Codex twins and automatic quota routing, so calls may go to OpenAI with or without Jev. No HUD or panel command. |
| [tailscale](plugins/tailscale) | Lets Claude query and modify your tailnet through the Tailscale API. |

## Install

Inside Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install chatgpt@spider-claude-mods
/plugin install codex-computer-use@spider-claude-mods
/plugin install codex-models@spider-claude-mods
/plugin install crew@spider-claude-mods
/plugin install tailscale@spider-claude-mods
```

To use a local copy instead of GitHub, pass the folder path:

```
/plugin marketplace add ~/dev/personal/claude-mods
```

The plugins here are function hooks mods, a Claude Code API still in early access that may change between versions.

See [Privacy and permissions](docs/PRIVACY.md) for what each plugin reads and saves, and [Verification](docs/VERIFICATION.md) for what the tests cover and what they do not.

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

The first use of an app asks in a band above the prompt: `This session` (key `1`), `Always` (key `2`, also saved in Codex's own `ComputerUseAppApprovals.json`) or `No` (key `3`). Each question has a fixed five-minute deadline, counted from before it enters the queue; a timeout or a clock or polling failure never approves an app. A `No` is kept for that caller and the call is refused without asking again; organization and safety blocks from Codex pass through as they are. The first call of a new or reset Codex session must be one documented entry call (`await cua.getState();` or `let app = await cua.getApp("Calculator");`), whose result carries the API documentation.

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

It copies the helper to `~/.claude/mcp/codex-cu` (keeping `state/`, where the approvals and the log live) and loads the LaunchAgent; run it again after a helper change. The socket lives in `run/helper.sock` and approvals in `state/approvals.json`, both in fixed directories beside the installed `helper.mjs`. `install.sh` accepts only `--check` (checks prerequisites without installing) or no arguments. `uninstall.sh` accepts no arguments, removes the LaunchAgent and retains code, approvals and logs. Neither script edits `settings.json`. To load the plugin from the folder instead of the marketplace, run `claude --plugin-dir plugins/codex-computer-use`.

Limitations: ownership is checked for apps named as string literals in `cua.getApp(...)` and for the app each result reports, so an app reached through a variable is owned only after its first call; Codex refuses an action when the app changed since it was last read ("The user changed …"), so read and act in the same call.

## codex-models

Offers OpenAI Codex models (ChatGPT login) in Claude Code through a local loopback proxy. They appear in `/model` next to the Claude models, and an agent definition can name one in its `model:` field. Claude models pass through the proxy to Anthropic unchanged. The proxy is our own Go code, under `plugins/codex-models/proxy/`. Its status reply (`GET /__ccmproxy/status`) carries `codexLimits`, the Codex rate-limit windows read from the `x-codex-*` headers of the answers it already proxies. Only `?refresh=limits`, requested by crew's quota routing, may also read OpenAI's unofficial `wham/usage` endpoint, at most once every 5 minutes; a plain status never calls OpenAI.

Needs macOS, [mise](https://mise.jdx.dev) (it provides Go 1.27.1 and Node 24; `install.sh` checks and tells you what to `mise install`) and a ChatGPT account with Codex access. A plugin cannot set `env` or `modelPicker` in settings, so the installer writes them.

### Install

1. Install the plugin: `/plugin install codex-models@spider-claude-mods`. Its files land in `~/.claude/plugins/cache/spider-claude-mods/codex-models/<version>/`.
2. Run the installer from that folder, or from a checkout of this repository (at `plugins/codex-models/`):

   ```
   ~/.claude/plugins/cache/spider-claude-mods/codex-models/<version>/install.sh
   ```

   `install.sh --check` checks prerequisites and settings without changing anything; `--dry-run` prints the `settings.json` diff it would write, with every proxy token masked, without changing the installation. These are the installer's only flags.
3. Sign in to ChatGPT once: `~/.claude/codex-models/ccmproxy login codex` (inside Claude Code: `! ~/.claude/codex-models/ccmproxy login codex`).
4. Start a new Claude Code session; running ones keep their old settings. `/codex-models:status` shows whether the proxy answers, the login, the models and the settings.

The installer checks settings before building, copying files or touching the LaunchAgent. It accepts no existing `ANTHROPIC_BASE_URL` or the current configured proxy URL; a different URL, or a missing proxy config with a URL already set, requires uninstall first. Reinstalling with the same config is idempotent.

It builds the proxy into `~/.claude/codex-models/`, initializes the config (loopback only, random port and secret), loads the LaunchAgent `com.anderson-spider.codex-models`, and verifies the running proxy before editing `~/.claude/settings.json`: the status must refuse a request without the secret, accept it with the secret, identify `ccmproxy` at the installed version, and answer the session-start probe. A changed settings file gets a timestamped backup beside its symlink-resolved target, then an atomic write that refuses concurrent changes. Settings and regular backups are restricted to mode 600; filesystem failures abort the operation.

### What changes in `settings.json`

- `env.ANTHROPIC_BASE_URL`: the local proxy. The installer refuses to run if another value is already set.
- `env.ANTHROPIC_CUSTOM_HEADERS`: one `X-Ccmproxy-Token: <secret>` line added; your other lines stay.
- `env.ENABLE_TOOL_SEARCH=true`: Claude Code turns MCP tool search off for a custom base URL otherwise. Install sets it regardless of its previous value; uninstall removes the key.
- `modelPicker.options`: one row per Codex model, with a description ending in `(codex-models)`.

Claude models still go to Anthropic through the proxy, unchanged, with your usual login.

### Codex models

| Id | Label | Default effort | Behaves as in Claude Code |
| --- | --- | --- | --- |
| `gpt-6.1-sol` | GPT-6.1 Sol | low | `claude-sonnet-5-5` |
| `gpt-6-astra` | GPT-6 Astra | medium | `claude-opus-5-5` |
| `gpt-6-sol` | GPT-6 Sol | medium | `claude-sonnet-5-5` |
| `gpt-6-luna` | GPT-6 Luna | medium | `claude-haiku-5-5` |
| `gpt-5.6-sol` | GPT-5.6 Sol | low | `claude-sonnet-5-5` |
| `gpt-5.6-terra` | GPT-5.6 Terra | medium | `claude-sonnet-5-5` |
| `gpt-5.6-luna` | GPT-5.6 Luna | medium | `claude-haiku-5-5` |

The catalog is fixed to the listed models; access to each model is decided upstream. `gpt-daybreak-blue-latest` is gated by the false `OfferDaybreakBlue` constant and is not offered. Picker rows use bare model ids; effort suffixes are accepted in requests but are not advertised as separate rows. See [the proxy's README](plugins/codex-models/proxy/README.md) for the model names and credentials.

### Proxy config and login

`~/.claude/codex-models/home/config.json` contains `listen_http`, `upstream`, `auth_token`, `session_salt`, `auth_dir`, `log_level` and `codex.base_url`. Unknown keys are ignored; known fields retain JSON type checks and validation of destinations, secrets and file permissions. `config init` preserves existing values, including unknown keys, and adds missing secrets. The backend user agent, originator (`codex-tui`), OAuth callback port (1455), model catalog and picker-row policy are fixed in code.

Sign-in uses `ccmproxy login codex` and the proxy's native `<auth_dir>/codex.json` credential file, written atomically at mode 600 in a mode-700 directory. It does not reuse Codex CLI credentials. One exclusive lock, `<canonical auth_dir>/codex.json.lock`, coordinates login, refresh and logout; directory aliases converge on that lock, and credential-file symlinks are refused.

### Use the models

- Main session: pick a row in `/model`; choose the effort with `/effort`. Suffixes such as `gpt-6-luna-high` pin the effort instead.
- Subagent: put the model id in the agent's frontmatter, for example `model: gpt-6-astra`.
- Crew plugin: at session start, with the local loopback proxy as `ANTHROPIC_BASE_URL`, crew registers a fixed role-to-model map of Codex twins. Registration does not discover or filter models through status; the separate status read supplies quota routing.

What a Codex model reads and writes is sent to OpenAI. See [docs/PRIVACY.md](docs/PRIVACY.md).

### Uninstall

```
~/.claude/codex-models/uninstall.sh
```

Uninstall takes no flags. It cleans the current settings without an install-state file or restoring previous values: removes `ANTHROPIC_BASE_URL` only when it is loopback HTTP and our token header was present, removes our token header lines while keeping others, removes `ENABLE_TOOL_SEARCH` by name, and removes only picker rows marked `(codex-models)`. Unrelated settings stay; empty owned keys and containers are dropped, but `settings.json` stays even when its result is `{}`.

Settings cleanup and its mode-600 backup must succeed before the LaunchAgent is stopped and removed; malformed containers or a write failure keep the service loaded. Restart running sessions. `~/.claude/codex-models/` stays with its native login, config, logs, binary and scripts for inspection and reinstall. The scripts never delete backups, which may hold the proxy's secret. Uninstall the plugin with `claude plugin uninstall codex-models@spider-claude-mods`.

Limitations: the proxy assumes a single-user Mac. While it is down, another local user can bind its port and would receive the secret header and the Claude login that Claude Code sends. A changed settings file is written as 2-space JSON.

## crew

Five specialist subagents, optional Jev sizing, fixed-model Codex twins and automatic quota routing. See [the crew README](plugins/crew/README.md) for setup, delegation, privacy and verification.

## tailscale

Registers two tools for Claude to talk to the Tailscale API (`https://api.tailscale.com/api/v2`), authenticated by the `TS_API_KEY` environment variable, which must be exported when Claude Code starts:

| Tool | What it does |
| --- | --- |
| `mcp__tailscale__tailscale_get` | Read-only (`GET`): devices, ACL, DNS, keys, users, invites, settings, webhooks, logs, device posture, services, OAuth apps and contacts. E.g. `/tailnet/-/devices`. Accepts `fields` to return only the requested keys (the API does not paginate, so the whole list comes back). Strips `machineKey`, `nodeKey`, `tailnetLockKey`, `secret`, `s3SecretAccessKey` and `token` from the response and shows the `ETag` when there is one. |
| `mcp__tailscale__tailscale_write` | Modifies the tailnet (`POST`, `PUT`, `PATCH`, `DELETE`): tags, routes, ACL, DNS, deleting devices, keys, webhooks. Accepts `ifMatch`. The response comes back complete, because the API shows a new key's secret only once. |

They are separate so you can allow read-only without a prompt and keep write asking for confirmation. The `path` must be relative to the API and start with `/`; `//host`, `..`, a lone `.` segment, empty segments (`//` in the path), `%` in the path (the query may use it), control characters, `\`, `#`, blanks and full URLs are rejected. A `-` in place of the tailnet means the default one.

To update the ACL without overwriting someone else's edit: do a `GET /tailnet/-/acl`, keep the response's `ETag` and pass it in `ifMatch` on the `POST /tailnet/-/acl` (the API responds 412 if the ACL changed). A string `body` that is not valid JSON is sent as HuJSON, so a policy with comments works. `DELETE /tailnet/{tailnet}`, which deletes the whole tailnet, is refused by the tool.

`TS_API_KEY` must be a `tskey-api-...` key. An OAuth secret `tskey-client-...` is not valid as a Bearer without a token exchange, which the plugin does not do.

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
claude plugin validate plugins/chatgpt
claude plugin test plugins/chatgpt
claude plugin validate plugins/codex-computer-use
claude plugin test plugins/codex-computer-use
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs
claude plugin validate plugins/codex-models
claude plugin test plugins/codex-models
go -C plugins/codex-models/proxy test -race ./...
go -C plugins/codex-models/proxy test -race -tags contract ./...
node --test plugins/codex-models/tests/scripts/*.test.mjs
claude plugin validate plugins/crew
claude plugin test plugins/crew
claude plugin validate plugins/tailscale
claude plugin test plugins/tailscale
```
