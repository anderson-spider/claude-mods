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

Registers five subagent types when a session starts, each with a default model and effort and a tool allowlist. Claude delegates to them through the Agent tool by their descriptions, or you can ask for one by name:

| Agent type | Default model | Tools | Role |
| --- | --- | --- | --- |
| `crew:code-reader` | Haiku | Read, Grep, Glob | Finds and explains code; returns `path:line` summaries. Never edits. |
| `crew:research` | Haiku | Read, Grep, Glob, Edit, Write, WebSearch, WebFetch, Context7 and browser tools (terminal-browser, Claude in Chrome) | Researches docs and the web, browsing pages when needed, and writes findings or documentation. Never edits source code. |
| `crew:designer` | Sonnet | Read, Grep, Glob, Edit, Write, WebSearch, WebFetch, Context7 and browser tools | Specifies the UI and experience (layout, states, accessibility, copy) and edits styles and layout. Leaves logic and tests to the developer. |
| `crew:developer` | Sonnet | Read, Grep, Glob, Edit, Write, Bash | Implements a spec, adds and runs relevant tests, and reports exact commands/output for the independent architect audit. |
| `crew:architect` | Opus | Read, Grep, Glob, Write, Bash | The architect: plans and reviews a design or diff for bugs, regressions and missing tests. Writes plan and review documents under `.crew/` only, never code. |

Layout in the project where the agents run (unversioned, added to `.gitignore` by the skill):

```
.crew/
  plans/<name>.md       the plan you approve
  reviews/<name>.md     the architect's independent reviews
  research/<name>.md    the research agent's findings
```

The architect can only write Markdown under `.crew/`: a hook denies any other `Write` or `Edit` by that role. Unknown `crew:` types, including stale removed-role definitions, have no lane and their `Write`/`Edit` calls are held. This guard does not screen `Bash` writes. Plans and reviews live in `.crew/`, which the `brainstorm` skill adds to the repository's `.gitignore` when it is not ignored yet.

### The lead

In a request that offers the Agent tool (the main session; the crew agents do not have it), a system prompt section makes Claude the lead: it talks with you, breaks the work down and hands every task that reads, searches, edits or runs anything in the project to the crew agent for that kind of work. It plans in waves: it splits the work into independent pieces, launches every piece whose inputs are ready in one message and, after each report, launches what is newly unblocked without being asked. Each update ends with one line on what runs and what waits. The developer runs relevant tests itself and reports exact commands/output; a step counts as done only after someone other than its implementer independently audits it (`crew:architect`, or its registered Codex twin). The architect may rerun tests. A failure goes back to the same developer, then the architect reaudits. It does not judge a task's size: with a `jevKey`, Jev sizes each call; without one, each agent runs on the model sized for its role. A teammate's prompt does not get the section. Git and pull requests stay with the lead.

### Native Codex subagents

At session start, a local HTTP loopback proxy as `ANTHROPIC_BASE_URL` enables a `crew:<role>-codex` twin for each of the five roles. The model map is fixed:

| Base role | Codex model |
| --- | --- |
| `code-reader`, `research` | `gpt-6-luna` |
| `designer`, `developer` | `gpt-6.1-sol` |
| `architect` | `gpt-6-astra` |

Twins use the base role's prompt, tools and write rules. They are ordinary foreground or background subagents and need no Codex CLI. The URL must be `http` on `127.0.0.0/8`, `::1` or `localhost`; with any other base URL, or none, no twins are registered. There is no discovery request, model filtering or secret read at startup: the gate checks the URL, not proxy identity or model availability. The proxy must serve the fixed ids. One failed registration leaves the others available. What these subagents read and write goes to OpenAI through the proxy.

When twins are registered, a separate prompt section tells the lead it can pick one when you ask for Codex or when a second model family should do or audit the work. Only the architect role or its registered twin independently accepts a step; a developer twin's own test run remains its report, not acceptance. Never pass `model` to a twin: the call is refused rather than overriding its fixed model. A new session registers twins; `/reload-plugins` alone (or a `jevKey` change) leaves the new activation's registered set empty, so quota routing and the twin section wait for the next session.

With a `jevKey`, Jev may size a twin's effort, but never changes its model family. Crew internally supplies `<fixed model id>:<effort>` on the spawn, with effort bounded to medium or high. A Jev failure on an explicit twin uses `:medium`; quota-switched calls also use `:medium` when Jev is absent or fails. Caller-supplied `model` values, including suffixes, remain refused. This does not depend on a late step bind or on the host sending an effort field. A real-host spike against a local fake verified that `:medium` and `:high` reached the outgoing request unchanged while the host's own effort stayed medium; the proxy gives the suffix precedence.

The task and notice show the canonical `<model>/<effort>` request configuration. Confirmation compares the API-reported model against the exact id or its dated release, and records effort only from outgoing request evidence (the model suffix takes precedence over the step effort). If effort cannot be observed, the line confirms only the model and says `suffix <effort> requested, effort unobserved`; the record keeps `ran.effort: null`, never the planned value. Multiple-turn/backend validation remains separate from the spike.

### Quota-aware routing

Automatic whenever twins are registered, with or without Jev. An eligible `crew:<role>` call goes to its registered `crew:<role>-codex` twin when Codex has clearly more 7-day headroom than Claude (at least 10 points less used; a provider with its 5-hour window at 90% or more is avoided). Claude's limits come from the host. Codex's come from `GET /__ccmproxy/status?refresh=limits` on the local loopback proxy, with the secret header from `ANTHROPIC_CUSTOM_HEADERS`, under a 1.5-second deadline. The first eligible spawn reads the quota, not session start; readings and failures are cached for 60 seconds, concurrent callers share one refresh, and readings more than 15 minutes old are stale. With no registered twins, there is no quota fetch.

Anything uncertain (no limits, a stale or failed read) keeps the call on Claude. A base-role call that names a model, a twin you named, a fork, a teammate and a workflow script's agent are never moved. The task and a notice name a switched call's provider. This is the one case where crew changes a call's agent type; the twin has the same tools and write rules. With a Codex decision, the call's work goes to OpenAI through the proxy even when `jevKey` is empty. With a key, Jev sizes the twin's bounded effort through the internal model suffix above; without an answer, the suffix is `:medium`. Crew has no HUD or `/crew:panel` command.

### Jev routing of model and effort

The only configurable option is `jevKey`: with a TypeSafe key there, Jev routes; with it empty, no Jev request or trust-settings read is made. Automatic quota routing is independent of this key. Save the key in the plugin's config, which keeps it in secure storage and not in a settings file:

```sh
read -rs k && printf '%s' "$k" | jq -Rs '{jevKey:.}' | claude plugin configure crew@spider-claude-mods --values-stdin; unset k
```

(Paste the key at the silent prompt; it is not echoed or kept in shell history. `claude plugin configure crew@spider-claude-mods` without `--values-stdin` only lists the options and which are unset, so use it to check that the key is set; inside Claude Code, `/plugin configure crew@spider-claude-mods` also sets it, which is where the CLI points.) With a key, Jev decides per Agent call which model and effort a `crew:*` agent runs on, one step from its default at most (the architect never below Opus, and no agent's effort below medium). The agent type stays the one Claude chose (unless quota-aware routing moves the call to its role's twin, which has the same tools and write rules), so those do not change; a call that names a model (a `-codex` twin that names one is refused instead), a fork, a workflow script's agent and any other agent type are left alone. The task's description ends with the choice (`audit auth · opus/high`); on the subagent's first step a transcript line confirms what ran or says what ran instead (`crew: jev: audit auth: confirmed claude-opus-5-5 · high`), a notice shows each decision once the subagent has started (and says when an effort could not be applied), and a debug log line records the tier, confidence, depth and Jev model id.

- **Key**: the `jevKey` option is the only source and the only switch. It must be printable ASCII of 512 characters or fewer with no spaces; an empty value turns Jev routing off silently, and a malformed one turns it off with a debug log line (never showing the value). A `jevKey` that the repository's own project or local settings declare turns Jev routing off; a `HOME` they declare is ignored. Jev routing is also off when those settings cannot be read; a debug log line gives the reason. Changing `jevKey` reloads the plugin. Environment variables (`TYPESAFE_API_KEY`, `JEV_API_KEY`) and `~/.jev-router.env` are not read. With `--plugin-dir` the plugin is `crew@inline`, which `configure` refuses because it is not installed; the key is read from `pluginConfigs["crew@inline"].options.jevKey` in `~/.claude/settings.json` (plain text there), so prefer testing with the installed plugin.
- **Sent** to `api.typesafe.ai`: the agent name, the call description and the prompt with secrets, emails and paths removed and cut to 4000 characters. See [docs/PRIVACY.md](docs/PRIVACY.md).
- **Fail open**: on a Jev error, a timeout (3 s) or more than four calls at once, Claude calls keep their model and effort. An explicit twin whose Jev request fails uses its fixed model with `:medium`, and automatic quota routing can still choose a twin with the same default suffix.
- **Thresholds**: a depth of 3.0 or more on Jev's 0-4 scale gives `high` effort, below it `medium`, and a depth within 0.01 of 3.0 keeps the agent's default; a tier answer applies from confidence 0.5. The decision log and the debug log are where to revisit them.
- **Decision log**: with a key set and a trusted home, each routed decision is also saved as a small JSON file in `~/.claude/crew/decisions/` (tier, confidence, depth, models, efforts, duration, a hash of the description, and an empty `outcome` for you to fill in; no prompt, description, key or path). The v2 schema keeps twin model fields canonical (no suffix). `bind: "suffix"` means a twin spawn succeeded with the effort suffix, including medium defaults; `applied.model` remains false, and `applied.effort` indicates a change from the default configuration, not observed execution. `ran` holds only API model/outgoing effort evidence. It stays on your machine and is never pruned: delete the folder to clear it. For example: `duckdb -c "select tier, effortApplied, count(*) from read_json_auto('~/.claude/crew/decisions/*.json') group by all"`.

A `jevKey` that is not a string makes Claude Code refuse to load the whole plugin (all five agents), not only the routing.

The plugin also ships a `brainstorm` skill that says how to plan with these agents: gather context with `code-reader` and `research` in parallel, let `architect` challenge the leading option, then write one plan, with each step's dependencies and files and the waves of steps that can run in parallel, before `developer` implements it. Once you approve the plan, it recommends `/goal`, `/loop` or direct execution, without starting any of them.

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
