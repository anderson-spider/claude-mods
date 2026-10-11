# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in a folder under `plugins/` and is listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [branch-guard](plugins/branch-guard) | Holds a `git commit` or `git push` on the protected branch and shows what would go in. |
| [chatgpt](plugins/chatgpt) | Lets Claude ask your logged-in ChatGPT, or have it generate an image, in terminal-browser, Claude in Chrome or the Claude desktop app's built-in browser, and saves the result locally. |
| [codex-computer-use](plugins/codex-computer-use) | Routes native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [crew](plugins/crew) | Registers six specialist subagents: `code-reader` and `research` on Haiku; `designer`, `developer` and `tester` on Sonnet; `architect` on Opus. Optional Jev routing of each call's model and effort, on when the `jevKey` option is set. Optional Codex engine to run a role on OpenAI Codex, on when the `codex` option is set. Includes the [Flightdeck](https://github.com/scasella/claude-flightdeck) dashboard. |
| [tailscale](plugins/tailscale) | Lets Claude query and modify your tailnet through the Tailscale API. |

## Install

Inside Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install branch-guard@spider-claude-mods
/plugin install chatgpt@spider-claude-mods
/plugin install codex-computer-use@spider-claude-mods
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

## crew

Registers six subagent types when a session starts, each with a default model and effort and a tool allowlist. Claude delegates to them through the Agent tool by their descriptions, or you can ask for one by name:

| Agent type | Default model | Tools | Role |
| --- | --- | --- | --- |
| `crew:code-reader` | Haiku | Read, Grep, Glob | Finds and explains code; returns `path:line` summaries. Never edits. |
| `crew:research` | Haiku | Read, Grep, Glob, Edit, Write, WebSearch, WebFetch, Context7 and browser tools (terminal-browser, Claude in Chrome) | Researches docs and the web, browsing pages when needed, and writes findings or documentation. Never edits source code. |
| `crew:designer` | Sonnet | Read, Grep, Glob, Edit, Write, WebSearch, WebFetch, Context7 and browser tools | Specifies the UI and experience (layout, states, accessibility, copy) and edits styles and layout. Leaves logic and tests to the developer. |
| `crew:developer` | Sonnet | Read, Grep, Glob, Edit, Write, Bash | Implements a spec, adds tests and runs them. |
| `crew:tester` | Sonnet | Read, Grep, Glob, Edit, Write, Bash | Reproduces a behavior, writes the tests, runs the suite and reports the output. Never changes production code. |
| `crew:architect` | Opus | Read, Grep, Glob, Write, Bash | The architect: plans and reviews a design or diff for bugs, regressions and missing tests. Writes plan and review documents under `.crew/` only, never code. |

Layout in the project where the agents run (unversioned, added to `.gitignore` by the skill):

```
.crew/
  plans/<name>.md       the plan you approve
  reviews/<name>.md     the architect's reviews
  research/<name>.md    the research agent's findings
```

The architect can only write Markdown under `.crew/` and the tester only test files: a hook denies any other `Write` or `Edit` by those agents. Plans and reviews live in `.crew/`, which the `brainstorm` skill adds to the repository's `.gitignore` when it is not ignored yet.

### The lead

In a request that offers the Agent tool (the main session; the crew agents do not have it), a system prompt section makes Claude the lead: it talks with you, breaks the work down and hands every task that reads, searches, edits or runs anything in the project to the crew agent for that kind of work, in parallel when the tasks are independent. It does not judge a task's size: with a `jevKey`, Jev sizes each call; without one, each agent runs on the model sized for its role. A teammate's prompt does not get the section. Git and pull requests stay with the lead.

### Codex engine

Off by default; the `codex` option is the switch. When on, the lead can run any crew role on OpenAI Codex instead of as a Claude subagent, through the local Codex CLI (`codex` on your `PATH`, logged in). The prompt the lead writes and the repository content the job reads are sent to OpenAI by that CLI, under your Codex login and plan. With the option off nothing is registered or run.

It registers three tools, which only the main session may call (a subagent's call is refused):

| Tool | What it does |
| --- | --- |
| `mcp__crew__codex` | Runs a role (`agent`, `prompt`, `description`, optional `cwd`, `background`, `resume`) on Codex. It waits up to 20 seconds and returns as soon as the job ends; past that, or when you press Esc (which also asks Codex to stop), the job keeps running in the background. `background: true` returns at once, once the job's record is saved. A relative `cwd` is taken from the session's directory. |
| `mcp__crew__codex_result` | Takes a `jobId` and returns JSON: status, agent, description, the answer once the job ended (up to 50,000 characters), the last activity while it runs, and the error, usage, files and resumability when they apply. |
| `mcp__crew__codex_cancel` | Takes a `jobId` and asks Codex to stop (SIGINT), only once `ps` shows the job's pid as a running `codex exec`. It answers `cancelling`; the job ends `cancelled` once Codex has stopped. A SIGINT that could not be sent is reported and tried again by the next cancel. One that was sent is not repeated or escalated, so a Codex that ignores it stays `cancelling` until it ends. |

Each role runs with a fixed sandbox that the lead cannot change:

- Read-only: `code-reader`, `research` and `architect`. Codex saves the final message of `research` and `architect` to `.crew/research/<name>-<jobId>.md` and `.crew/reviews/<name>-<jobId>.md`, so they are told to make that message the whole findings or review and not to try to write files. If git does not already ignore `.crew`, a `.crew/.gitignore` of `*` is added (your root `.gitignore` is left alone).
- Workspace-write: `developer`, `designer` and `tester`. They are refused outside a git repository and when `cwd` is outside the repository. The crew pins their extra writable roots to none and their network access off.

The sandbox is not a hard limit: approvals are on-request and Codex's own auto-review answers a request to leave it (network, an install, a path outside the root); a command that fails first and is then retried is not a failed job. The crew's `Write` and `Edit` guard does not apply to Codex: the tester's and designer's lanes are prompt-only there. Your `~/.codex` configuration still applies (model, MCP servers, web search), except the sandbox, approval, writable-root and network keys the crew sets. The optional `codexModels` option picks a Codex model per role (`developer=gpt-x,architect=gpt-y`); a role left out uses Codex's own default. Jev does not route Codex calls.

Each job runs in a detached worker (in its own session when `perl` is available, which also lets the cancel's SIGINT reach Codex) and keeps its files in `.crew/codex/` (in the session directory outside a git repository), which gets a `.gitignore` of `*`. A job survives `/reload-plugins`; it belongs to the Claude session that started it, and another session lists it read-only while its Codex runs; once that Codex has ended or is gone, the other session settles it from its files and can read and resume it. A job whose worker is gone comes back as `lost`; `resume` continues a job from its Codex session with the same agent and the original `cwd`, one resume of a session at a time. When a job ends in the background, a transcript line and a message to the lead give its id, role and status only; ask `codex_result` for the answer. In Flightdeck a job is a card titled `codex:<role>`, the architect included.

### Flightdeck dashboard

The plugin includes [Flightdeck](https://github.com/scasella/claude-flightdeck) 0.3.2 (MIT, vendored in `plugins/crew/hooks/flightdeck/`, with its license and a list of local changes): a pane with the main model's vitals, an architect panel, every permission check, subagent cards and swimlanes, a turn receipt and a session log, a status line, and `/crew:panel` (it replaces upstream's `/flightdeck`). Twelve of its thirteen options (`architectPattern`, `architectLabel`, `gateLabel`, `panels`, `motion`, `moments`, `matchDescriptions`, `maxCards`, `layout`, `palette`, `openOnStart`, `statusLine`) keep upstream's names and defaults; the thirteenth, `placement`, is new. `crew:architect` matches the default `architectPattern`, so its runs show in the ARCHITECT panel with its one-line verdict instead of as a card. Changing an option reloads the plugin, which also clears the Jev routing state (see below).

`/crew:panel [on|off|side|prompt|reset|layout auto|compact|wide|mini]`:

- Bare `/crew:panel` toggles the panel; `on` and `off` show and hide it.
- `side` shows it in the host's pane: beside the transcript from 110 columns in fullscreen, inline above the prompt otherwise (and on a narrow terminal an unasked pane waits undrawn until you ask for it).
- `prompt` shows a summary band above the prompt instead (model, context, permission checks and live agents) and closes the pane. The band always yields to another plugin's band, such as a commit held by branch-guard, which shows in its place. The surface raises the band on the terminal and the desktop app only; on other surfaces `prompt` shows nothing, so use `side` there.
- `layout auto|compact|wide|mini` sets the side pane's layout for the session; the band always shows the summary. `reset` clears the dashboard's state.

The `placement` option (`side` or `prompt`, default `side`) and `openOnStart` say what a session starts with before you have picked. Your last pick (shown or hidden, side or prompt) is saved and wins in later sessions, including a hide by the pane's close mark. A pick made in one session does not change another session that is already running.

If you have the Flightdeck plugin installed, uninstall it before updating crew (`claude plugin uninstall flightdeck@claude-flightdeck`): both would draw a pane and a status line. Options saved for `flightdeck@claude-flightdeck` do not carry over; set them again on `crew@spider-claude-mods`.

### Jev routing of model and effort

Off until you fill in the `jevKey` option: with a TypeSafe key there, Jev routes; with it empty, nothing is sent and nothing is read. Save the key in the plugin's config, which keeps it in secure storage and not in a settings file:

```sh
read -rs k && printf '%s' "$k" | jq -Rs '{jevKey:.}' | claude plugin configure crew@spider-claude-mods --values-stdin; unset k
```

(Paste the key at the silent prompt; it is not echoed or kept in shell history. `claude plugin configure crew@spider-claude-mods` without `--values-stdin` only lists the options and which are unset, so use it to check that the key is set; inside Claude Code, `/plugin configure crew@spider-claude-mods` also sets it, which is where the CLI points.) With a key, Jev decides per Agent call which model and effort a `crew:*` agent runs on, one step from its default at most (the architect never below Opus, and no agent's effort below medium). The agent type stays the one Claude chose, so the tools and the write rules do not change; a call that names a model, a fork, a workflow script's agent and any other agent type are left alone. The task's description ends with the choice (`audit auth · opus/high`); on the subagent's first step a transcript line confirms what ran or says what ran instead (`crew: jev: audit auth: confirmed claude-opus-5-5 · high`), a notice shows each decision once the subagent has started (and says when an effort could not be applied), and a debug log line records the tier, confidence, depth and Jev model id.

- **Key**: the `jevKey` option is the only source and the only switch. It must be printable ASCII of 512 characters or fewer with no spaces; an empty value turns routing off silently, and a malformed one turns it off with a debug log line (never showing the value). A `jevKey` that the repository's own project or local settings declare turns routing off entirely; a `HOME` they declare is ignored. Routing is also off when those settings cannot be read; a debug log line gives the reason. Changing any of the plugin's options reloads it. Environment variables (`TYPESAFE_API_KEY`, `JEV_API_KEY`) and `~/.jev-router.env` are no longer read. With `--plugin-dir` the plugin is `crew@inline`, which `configure` refuses because it is not installed; the key is read from `pluginConfigs["crew@inline"].options.jevKey` in `~/.claude/settings.json` (plain text there), so prefer testing with the installed plugin.
- **Sent** to `api.typesafe.ai`: the agent name, the call description and the prompt with secrets, emails and paths removed and cut to 4000 characters. See [docs/PRIVACY.md](docs/PRIVACY.md).
- **Fail open**: on an error, a timeout (3 s) or more than four calls at once, the call runs as Claude made it.
- The thresholds are untuned defaults; the debug log and the decision log are where to tune them.
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
claude plugin validate plugins/crew
claude plugin test plugins/crew
claude plugin validate plugins/tailscale
claude plugin test plugins/tailscale
```
