# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in a folder under `plugins/` and is listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [branch-guard](plugins/branch-guard) | Holds a `git commit` or `git push` on the protected branch and shows what would go in. |
| [chatgpt](plugins/chatgpt) | Lets Claude ask your logged-in ChatGPT, or have it generate an image, in terminal-browser, Claude in Chrome or the Claude desktop app's built-in browser, and saves the result locally. |
| [codex-computer-use](plugins/codex-computer-use) | Routes native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [codex-models](plugins/codex-models) | Offers OpenAI Codex models (ChatGPT login) in Claude Code through a local loopback proxy, in `/model` and in agent definitions; Claude models pass through to Anthropic unchanged. |
| [crew](plugins/crew) | Registers six specialist subagents: `code-reader` and `research` on Haiku; `designer`, `developer` and `tester` on Sonnet; `architect` on Opus. Optional Jev routing of each call's model and effort, on when the `jevKey` option is set. Optional `crew:<role>-codex` subagents on Codex models through a local proxy, on when the `nativeCodex` option is set. Optional quota-aware routing, on when the `quotaRouting` option is set. Draws a HUD of the crew's work in a side pane or a band above the prompt. |
| [tailscale](plugins/tailscale) | Lets Claude query and modify your tailnet through the Tailscale API. |

## Install

Inside Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install branch-guard@spider-claude-mods
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

## codex-models

Offers OpenAI Codex models (ChatGPT login) in Claude Code through a local loopback proxy. They appear in `/model` next to the Claude models, and an agent definition can name one in its `model:` field. Claude models pass through the proxy to Anthropic unchanged. The proxy is a vendored, hardened fork of ccmproxy, written in Go under `plugins/codex-models/proxy/`.

Needs macOS, [mise](https://mise.jdx.dev) (it provides Go 1.27.1 and Node 24; `install.sh` checks and tells you what to `mise install`) and a ChatGPT account with Codex access. A plugin cannot set `env` or `modelPicker` in settings, so the installer writes them.

### Install

1. Install the plugin: `/plugin install codex-models@spider-claude-mods`. Its files land in `~/.claude/plugins/cache/spider-claude-mods/codex-models/<version>/`.
2. Run the installer from that folder, or from a checkout of this repository (at `plugins/codex-models/`):

   ```
   ~/.claude/plugins/cache/spider-claude-mods/codex-models/<version>/install.sh
   ```

   `install.sh --check` only tests the prerequisites; `--dry-run` prints the `settings.json` diff it would write, with the secret masked; `--no-settings` does everything except the `settings.json` edit.
3. Sign in to ChatGPT once: `~/.claude/codex-models/ccmproxy login codex` (inside Claude Code: `! ~/.claude/codex-models/ccmproxy login codex`).
4. Start a new Claude Code session; running ones keep their old settings. `/codex-models:status` shows whether the proxy answers, the login, the models and the settings.

The installer builds the proxy into `~/.claude/codex-models/`, loads the LaunchAgent `com.anderson-spider.codex-models` (loopback only, random port, new secret), checks that the running proxy answers as this install's, and only then edits `~/.claude/settings.json`, keeping a timestamped backup beside it when the file changes. The file holds the proxy's secret, so it and its backups are left at mode 600, and a `settings.json` owned by another user is refused before anything changes.

### What changes in `settings.json`

- `env.ANTHROPIC_BASE_URL`: the local proxy. The installer refuses to run if another value is already set.
- `env.ANTHROPIC_CUSTOM_HEADERS`: one `X-Ccmproxy-Token: <secret>` line added; your other lines stay.
- `env.ENABLE_TOOL_SEARCH=true`: Claude Code turns MCP tool search off for a custom base URL otherwise. It is set even over a `false` you had; uninstall puts your value back.
- `modelPicker.options`: one row per Codex model, with a description ending in `(codex-models)`.

Claude models still go to Anthropic through the proxy, unchanged, with your usual login.

### Codex models

| Id | Label | Default effort | Behaves as in Claude Code |
| --- | --- | --- | --- |
| `gpt-6.1-sol` | GPT-6.1 Sol | low | `claude-sonnet-5` |
| `gpt-6-astra` | GPT-6 Astra | medium | `claude-opus-5` |
| `gpt-6-sol` | GPT-6 Sol | medium | `claude-sonnet-5` |
| `gpt-6-luna` | GPT-6 Luna | medium | `claude-haiku-4-5` |
| `gpt-5.6-sol` | GPT-5.6 Sol | low | `claude-sonnet-5` |
| `gpt-5.6-terra` | GPT-5.6 Terra | medium | `claude-sonnet-5` |
| `gpt-5.6-luna` | GPT-5.6 Luna | medium | `claude-haiku-4-5` |

The catalog mirrors `codex debug models` for your account; whether the account may use each model is decided upstream. `gpt-daybreak-blue-latest` (Daybreak Blue access program) is not offered unless you list it in the proxy's `codex.models` setting, which then limits the catalog to the ids it names. See [the proxy's README](plugins/codex-models/proxy/README.md) for the full list, the model names and the credentials.

### Use the models

- Main session: pick a row in `/model`; choose the effort with `/effort`. Suffixes such as `gpt-6-luna-high` pin the effort instead.
- Subagent: put the model id in the agent's frontmatter, for example `model: gpt-6-astra`.
- Crew plugin: set its `nativeCodex` option to `role=model` pairs (for example `developer=gpt-6-astra,tester=gpt-6-sol`); with the proxy as `ANTHROPIC_BASE_URL` it registers `crew:developer-codex`, `crew:tester-codex` and so on, with the same prompt, tools and write lane as the base role (see the crew section).

What a Codex model reads and writes is sent to OpenAI. See [docs/PRIVACY.md](docs/PRIVACY.md).

### Uninstall

```
~/.claude/codex-models/uninstall.sh
```

It removes exactly what the installer added to `settings.json` (a backup is left beside it), then stops and removes the LaunchAgent; restart running sessions. The Codex login, the config and the binary stay in `~/.claude/codex-models/`; `uninstall.sh --purge` deletes them too. Every install or uninstall that changes `settings.json` leaves a new backup beside it (mode 600). A backup can hold the proxy's secret, and neither script removes them, `--purge` included: delete `~/.claude/settings.json.bak-codex-models-*` yourself once you no longer need them. Then `claude plugin uninstall codex-models@spider-claude-mods`.

Limitations: the proxy assumes a single-user Mac. While it is down, another local user can bind its port and would receive the secret header and the Claude login that Claude Code sends. Changing `nativeCodex` reloads crew without a session start, so the `-codex` types appear from the next session. Uninstall restores `settings.json` with the same content, but a hand-formatted file comes back as 2-space JSON.

## crew

Registers six subagent types when a session starts, each with a default model and effort and a tool allowlist. Claude delegates to them through the Agent tool by their descriptions, or you can ask for one by name:

| Agent type | Default model | Tools | Role |
| --- | --- | --- | --- |
| `crew:code-reader` | Haiku | Read, Grep, Glob | Finds and explains code; returns `path:line` summaries. Never edits. |
| `crew:research` | Haiku | Read, Grep, Glob, Edit, Write, WebSearch, WebFetch, Context7 and browser tools (terminal-browser, Claude in Chrome) | Researches docs and the web, browsing pages when needed, and writes findings or documentation. Never edits source code. |
| `crew:designer` | Sonnet | Read, Grep, Glob, Edit, Write, WebSearch, WebFetch, Context7 and browser tools | Specifies the UI and experience (layout, states, accessibility, copy) and edits styles and layout. Leaves logic and tests to the developer. |
| `crew:developer` | Sonnet | Read, Grep, Glob, Edit, Write, Bash | Implements a spec, adds tests and runs them. |
| `crew:tester` | Sonnet | Read, Grep, Glob, Edit, Write, Bash | Reproduces a behavior, writes the tests, runs the suite and reports the output (longer reports under `.crew/reviews/`). Never changes production code. |
| `crew:architect` | Opus | Read, Grep, Glob, Write, Bash | The architect: plans and reviews a design or diff for bugs, regressions and missing tests. Writes plan and review documents under `.crew/` only, never code. |

Layout in the project where the agents run (unversioned, added to `.gitignore` by the skill):

```
.crew/
  plans/<name>.md       the plan you approve
  reviews/<name>.md     the architect's reviews (the tester's reports: <name>-test.md)
  research/<name>.md    the research agent's findings
```

The architect can only write Markdown under `.crew/` and the tester only test files and Markdown under `.crew/reviews/`: a hook denies any other `Write` or `Edit` by those agents. Plans and reviews live in `.crew/`, which the `brainstorm` skill adds to the repository's `.gitignore` when it is not ignored yet.

### The lead

In a request that offers the Agent tool (the main session; the crew agents do not have it), a system prompt section makes Claude the lead: it talks with you, breaks the work down and hands every task that reads, searches, edits or runs anything in the project to the crew agent for that kind of work. It plans in waves: it splits the work into independent pieces, launches every piece whose inputs are ready in one message and, after each report, launches what is newly unblocked without being asked. Each update ends with one line on what runs and what waits. A step counts as done only after someone other than its implementer verified it (`crew:tester` or `crew:architect`), and a failure goes back to the same agent. It does not judge a task's size: with a `jevKey`, Jev sizes each call; without one, each agent runs on the model sized for its role. A teammate's prompt does not get the section. Git and pull requests stay with the lead.

### The HUD

The plugin draws a HUD of the crew's work, always on and sending nothing out. In the side pane (id `crew`) it shows, in this order: a row for what waits on you (a permission dialog the person has to answer, never in the `auto`, `dontAsk` or `bypassPermissions` modes; a step ready for QA), the session (state, model and effort, context, cost, the last turn), the quota (Claude and Codex side by side, with the provider crew favors), the active plan's next steps, the agents running, the architect's verdicts (the first line of its answer: `Approve`, `Fixes` or `Reject`), the agents finished, the last 15 minutes and a log. It builds the fullest form that fits the pane's rows. There is no status line. Options: `placement`, `openOnStart`, `motion` (`while-active` or `off`) and `colors` (`theme` follows your Claude Code theme; `roles` gives each role a color). Changing an option reloads the plugin, which also clears the Jev routing state (see below).

The active plan is a Markdown file in `.crew/plans/` (the `brainstorm` skill writes it). At the start of a session the newest plan changed in the last 7 days that still has a step to do is followed; after that, the plan you write or edit, or the one you pin.

`/crew:panel [on|off|side|prompt|reset|layout auto|mini|plan <name>|plan auto]`:

- Bare `/crew:panel` toggles the panel; `on` and `off` show and hide it.
- `side` shows it in the host's pane: beside the transcript from 110 columns in fullscreen, inline above the prompt otherwise (and on a narrow terminal an unasked pane waits undrawn until you ask for it).
- `prompt` shows a summary band above the prompt instead and closes the pane. The band always yields to another plugin's band, such as a commit held by branch-guard, which shows in its place. The surface raises the band on the terminal and the desktop app only; on other surfaces `prompt` shows nothing, so use `side` there.
- `layout auto|mini` sets the side pane's layout for the session (`mini` keeps the summary even when docked); the band always shows the summary. `reset` clears what the HUD shows of the session's work and keeps the plan.
- `plan <name>` pins the plan `.crew/plans/<name>.md`; `plan auto` drops the pin and follows the plan last written, or, with none written in the session, the newest plan with steps left (as at the start). Only a `.md` directly under `.crew/plans/` counts.

The `placement` option (`side` or `prompt`, default `side`) and `openOnStart` say what a session starts with before you have picked. Your last pick (shown or hidden, side or prompt) is saved and wins in later sessions, including a hide by the pane's close mark. A pick made in one session does not change another session that is already running.

Not done yet: on the desktop, the profile pills, tinted card backgrounds, the pulsing dot and SVG gauges; in an agent's detail block, which Jev choice was kept, the last five tools and the first line of its answer.

### Native Codex subagents

Off by default; the `nativeCodex` option is the switch. Give it `role=model` pairs (for example `developer=gpt-x,tester=gpt-y`) and each role named there gets a `crew:<role>-codex` subagent type, such as `crew:developer-codex`, that runs on that model with the base role's prompt, tools and write rules. These are ordinary subagents: they run in the foreground or the background like any other and need no Codex CLI, but they reach their model through a local proxy set as `ANTHROPIC_BASE_URL` in the environment Claude Code starts in. The types are registered only when that URL is an `http` URL on a loopback address (`127.0.0.0/8`, `::1` or `localhost`); with any other base URL, or none, nothing is registered. What those subagents read and write is sent to OpenAI through the proxy.

When twins are registered, a separate section tells the lead it can pick one when you ask for Codex or when a second model family should do or check the work, without passing `model` (a spawn of a twin that names one is refused). Changing the option reloads the plugin, and the twins are not routed or offered to the lead until the next session. With a `jevKey`, Jev may size a twin's effort when the host sends one (not yet verified live) and never changes its model; the task shows `audit auth · <model>/<effort>`, and the transcript line confirms the model id the proxy reported. `crew:architect-codex` shows in the Review card; the others are agent cards.

### Quota-aware routing

Off by default; the `quotaRouting` option is the switch, and it needs the Native Codex subagents above. When on, a `crew:<role>` call whose role has a registered twin goes to `crew:<role>-codex` if Codex has clearly more 7-day headroom than Claude (at least 10 points less used; a provider with its 5-hour window at 90% or more is avoided). Claude's limits come from the host. Codex's come from the local proxy's status, read with the proxy's secret header from `ANTHROPIC_CUSTOM_HEADERS`, only when `ANTHROPIC_BASE_URL` is a loopback `http` URL. Anything uncertain (no limits, a stale or failed read) keeps the call on Claude. A call that names a model, a twin you named, a fork and a workflow script's agent are never moved. The task and a notice name the provider, and the Quota card shows the readings and the choice. This is the one case where crew changes a call's agent type; the twin has the same tools and write rules. With a Codex decision, the call's work goes to OpenAI through the proxy. With a `jevKey`, Jev then sets the twin's effort only.

### Jev routing of model and effort

Off until you fill in the `jevKey` option: with a TypeSafe key there, Jev routes; with it empty, nothing is sent and nothing is read. Save the key in the plugin's config, which keeps it in secure storage and not in a settings file:

```sh
read -rs k && printf '%s' "$k" | jq -Rs '{jevKey:.}' | claude plugin configure crew@spider-claude-mods --values-stdin; unset k
```

(Paste the key at the silent prompt; it is not echoed or kept in shell history. `claude plugin configure crew@spider-claude-mods` without `--values-stdin` only lists the options and which are unset, so use it to check that the key is set; inside Claude Code, `/plugin configure crew@spider-claude-mods` also sets it, which is where the CLI points.) With a key, Jev decides per Agent call which model and effort a `crew:*` agent runs on, one step from its default at most (the architect never below Opus, and no agent's effort below medium). The agent type stays the one Claude chose (unless quota-aware routing moves the call to its role's twin, which has the same tools and write rules), so those do not change; a call that names a model (a `-codex` twin that names one is refused instead), a fork, a workflow script's agent and any other agent type are left alone. The task's description ends with the choice (`audit auth · opus/high`); on the subagent's first step a transcript line confirms what ran or says what ran instead (`crew: jev: audit auth: confirmed claude-opus-5-5 · high`), a notice shows each decision once the subagent has started (and says when an effort could not be applied), and a debug log line records the tier, confidence, depth and Jev model id.

- **Key**: the `jevKey` option is the only source and the only switch. It must be printable ASCII of 512 characters or fewer with no spaces; an empty value turns routing off silently, and a malformed one turns it off with a debug log line (never showing the value). A `jevKey` that the repository's own project or local settings declare turns routing off entirely; a `HOME` they declare is ignored. Routing is also off when those settings cannot be read; a debug log line gives the reason. Changing any of the plugin's options reloads it. Environment variables (`TYPESAFE_API_KEY`, `JEV_API_KEY`) and `~/.jev-router.env` are no longer read. With `--plugin-dir` the plugin is `crew@inline`, which `configure` refuses because it is not installed; the key is read from `pluginConfigs["crew@inline"].options.jevKey` in `~/.claude/settings.json` (plain text there), so prefer testing with the installed plugin.
- **Sent** to `api.typesafe.ai`: the agent name, the call description and the prompt with secrets, emails and paths removed and cut to 4000 characters. See [docs/PRIVACY.md](docs/PRIVACY.md).
- **Fail open**: on an error, a timeout (3 s) or more than four calls at once, the call runs as Claude made it.
- **Thresholds**: a depth of 3.0 or more on Jev's 0-4 scale gives `high` effort, below it `medium`, and a depth within 0.01 of 3.0 keeps the agent's default (about 30% of the 126 decisions logged when it was set, against about half at 2.5: a snapshot); a tier answer applies from confidence 0.5. The decision log and the debug log are where to revisit them.
- **Decision log**: with a key set, each decision is also saved as a small JSON file in `~/.claude/crew/decisions/` (tier, confidence, depth, models, efforts, duration, a hash of the description, and an empty `outcome` for you to fill in; no prompt, description, key or path). It stays on your machine and is never pruned: delete the folder to clear it. For example: `duckdb -c "select tier, effortApplied, count(*) from read_json_auto('~/.claude/crew/decisions/*.json') group by all"`.

#### Upgrading to 0.5.0

The `jevRouting` option is gone and the environment variables and `~/.jev-router.env` are no longer read: Jev routes whenever `jevKey` is filled in. A stale `jevRouting` left in your settings is ignored. If you had turned routing off with `jevRouting: false` and still have a `jevKey` saved, clear it to stay off:

```sh
printf '{"jevKey":""}' | claude plugin configure crew@spider-claude-mods --values-stdin
```

If your key lives in `JEV_API_KEY`, move it into the option without printing it or leaving it in shell history:

```sh
printf '%s' "$JEV_API_KEY" | jq -Rs '{jevKey:.}' | claude plugin configure crew@spider-claude-mods --values-stdin
```

A `jevKey` that is not a string makes Claude Code refuse to load the whole plugin (all six agents), not only the routing.

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
claude plugin validate plugins/codex-models
claude plugin test plugins/codex-models
go -C plugins/codex-models/proxy test -race ./...
node --test plugins/codex-models/tests/scripts/*.test.mjs
claude plugin validate plugins/crew
claude plugin test plugins/crew
claude plugin validate plugins/tailscale
claude plugin test plugins/tailscale
```
