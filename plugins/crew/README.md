# crew

Install in Claude Code:

```
/plugin install crew --marketplace anderson-spider/claude-mods
```

The main session does the work: it implements, edits files, runs commands and tests, reviews its own changes, commits and opens pull requests, on the model you chose for the session. Crew adds three optional helpers it may call through the Agent tool, and nothing else; no task requires a subagent, and none of them is a review gate.

| Agent type | Model, effort | Tools | Role |
| --- | --- | --- | --- |
| `crew:planner` | Opus, high | Shared tools below | Plans complex or ambiguous work: decisions, dependencies, ordered steps, risks and acceptance criteria. |
| `crew:challenger` | Opus, high | Shared tools below | Questions a decision, design or change when an independent view adds value: premises, real risks, simpler options. Never a routine review. |
| `crew:digger` | Haiku, high | Shared tools below | Investigates code, git history, local docs, Context7, the web, GitHub, APIs and logs; returns evidence with paths and URLs, marked confirmed or inferred. |

All three helpers and their twins share Read, Grep, Glob, Bash, Write, Edit, WebSearch, WebFetch, Context7, CodeGraph and page-reading browser tools, when connected. They have no Agent or NotebookEdit. Their prompts allow file changes only when the request asks. The Write/Edit guard permits known crew types and refuses unknown ones; Bash is unscreened. Plans live in `.crew/plans/`, which the `brainstorm` skill adds to the repository's `.gitignore` when needed.

### The main session's section

In a request that offers the Agent tool (the main session; the helpers do not have it), a system prompt section says the main session implements and that the helpers are optional: the planner for complex or ambiguous work, the challenger only when an independent challenge adds real value, the digger for investigation. It asks for no helper on trivial work, no second call for what is settled, and the helper's summary rather than its transcript. With a `jevKey`, Jev sizes each helper call's effort. A teammate's prompt does not get the section.

### Native Codex twins

Each helper has a `crew:<role>-codex` twin on a fixed Codex model:

| Base role | Codex model |
| --- | --- |
| `planner`, `challenger` | `gpt-6-astra` |
| `digger` | `gpt-6-luna` |

A twin keeps its base role's prompt, tools and high effort. Never pass `model` to a twin: the call is refused rather than overriding its fixed model, and an unavailable model fails at the call instead of being replaced.

A twin registers at session start through one of two routes:

- **Codex login** (the `codexLogin` option): the planner, challenger and digger twins run through the crew Codex helper when it is installed and ready. Without a ready helper, no twin registers on the login; a gateway may still serve it.
- **Gateway:** a gateway as `ANTHROPIC_BASE_URL` (any `http` or `https` URL other than `api.anthropic.com`) serves every twin not on the login. Crew sends the fixed ids with the gateway's `cx/` prefix (`cx/gpt-6-luna`), and the gateway must route them and their `-medium` and `-high` variants to an endpoint that serves Codex.
- **Neither:** with Anthropic's API as base URL and no login, no twin registers.

A new session registers twins; `/reload-plugins` alone (or an option change) leaves the new activation's registered set empty. When twins are registered, a separate prompt section lists them: call one for a user-requested Codex call or a second model family's view.

With a `jevKey`, Jev may size a twin's effort but never changes its model. Crew supplies `cx/<fixed model id>-<effort>` on the spawn. Any Jev request or config failure, and a codex-mode switch without Jev, uses the role default (`-high`). The task and notice show the `<model>/<effort>` request; the first answered step's transcript line confirms the API-reported model and the outgoing effort, or says the effort was unobserved.

### Codex twins on your Codex login (experimental)

With `codexLogin` on (under `--plugin-dir` a plugin's options live under `crew@inline`), the twins run through the crew Codex helper using your ChatGPT Codex login. It needs the Codex CLI signed in with ChatGPT (`codex login`). Crew reads no login material; the helper's Codex process owns authentication.

The helper runs all three twins in `codex app-server`. `helper/install.sh` installs the helper and `helper/uninstall.sh` removes it. Run `install.sh --check` first to check the required Node runtime, Codex binary and login. Rerun `install.sh` after an update: helper 0.7.0 enables writes in the repository and temporary directories and network access for commands.

- **One turn per step:** the twin's step sends the agent's last request to the helper. The helper runs it as a turn on that agent's Codex thread and returns the final text.
  - Where the host runs the agent as a subagent, it only delivers a result through `SubagentHandback`, so the final answer is returned as that call, a failure included. The planner and challenger twins do the same.
  - If the host asks for another step right after a handback with nothing new, the twin answers with the handed-back message and does not run again; a follow-up through `SendMessage` is a new turn on the same thread.
  - Helper twins send no usage, so they have no confirmation line or `ran` record. Codex's own commands never reach Claude Code.
- **Workspace-write sandbox:** the thread works in the repository; the repository, `/tmp` and `$TMPDIR` are writable, commands have network access, and `approvalPolicy: never` prevents escalation. File changes still require a request in the prompt.
  - The helper resolves the directory on every turn. It refuses the filesystem root, your home or a parent of it, and anything inside or containing `~/.codex`, `~/.claude` or the helper itself.
  - A repository with its own `.codex/config.toml` (or under a directory that has one, up to your home) is refused: Codex would load it and could run the programs it names outside the sandbox.
  - Web search is off, and commands run in a non-login shell with Codex's core environment. On the helper a twin reads the code and git history and has two MCP tools, Context7 and CodeGraph (below); commands can access the network.
- **Isolated Codex home:** the server runs with its own `CODEX_HOME` (`~/.claude/mcp/crew-codex/state/codex-home`, mode 0700), holding only a link to your `~/.codex/auth.json`. Codex apps, plugins, hooks, computer use and browser use are disabled, so none of your Codex MCP servers or hooks load into a crew thread, and your Codex config is never read.
- **Two fixed MCP servers:** the helper declares `context7` (`https://mcp.context7.com/mcp`, anonymous, so with the service's anonymous rate limit) and `codegraph` (your `codegraph serve --mcp`, found under `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin`; left out when absent; started with the helper's own `node` first on its `PATH`, because a launchd job has none) itself, one `-c mcp_servers.<name>...` each. Nothing else is configurable. The CodeGraph tool needs the repository's `.codegraph/` index, and it runs outside Codex's sandbox, as you. Crew never reads or writes `auth.json`.
- **Shared limits:** at most four turns run at once, and a turn is stopped after fifteen minutes. A turn that does not stop within thirty seconds of an interrupt is abandoned with its thread. Threads are ephemeral and live until the cap or a restart.
- **Registration:** with `codexLogin` on, crew asks the helper's status once at session start, which starts nothing. Only roles advertised by a ready helper register on the login. Otherwise no login twin registers and a debug line says why; a gateway can still serve those twins.

The option is off by default, and a repository's own settings that set it, or declare `HOME`, keep it off.

### Crew mode

The `mode` option (`claude` or `codex`, `claude` by default) is the mode every session starts in. `/crew-mode codex` or `/crew-mode claude` switches the running session, and `/crew-mode` alone toggles it; the option does not change. While the session is in codex the status line shows `crew: codex`.

In codex, a plain `crew:<role>` call goes to its registered twin, and a role without one stays on Claude. A call that names a model, a twin you named, a fork, a teammate and a workflow script's agent are never moved. The task and a notice name a switched call (`crew:digger -> Codex (crew mode) · gpt-6-luna · high`), and its work goes to OpenAI. A `mode` that the repository's own settings declare, or settings that cannot be read, start the session in claude.

### HUD

`/crew-hud` opens a **pane** of bordered boxes, scrolled by the host while it has the keyboard and closed by Escape. Its head names a lone plan and counts running and recent helpers; its foot counts every helper:

- **Plan:** each plan's deliverables as a tree, with the plan's totals on its title row. A step hangs under its first dependency, one glyph shows its state (`●` done, `◎` working, `■` blocked, `○` queued, `?` unknown), a queued step says `waits <id>` or `ready` from its dependencies, a fully done branch folds into `[+N done]`, and a step a running helper was spawned for shows `← <role>`.
- **Agents · running:** a card per running helper: role (`·codex` for a twin), plan step, model and effort, elapsed time, a context bar (the last step's input against a 200k window for Claude models; a twin's window is unknown), steps, input and output tokens, and its last three tool calls by name with the call and failure counts. A wide pane draws a card's figures on its first line, a narrow one on a second.
- **Recent:** the last five ended helpers with their time, tokens, steps and how long ago; `max_tokens` is marked as failed.
- **Last 15 minutes:** one bar per helper, a running one reaching the right edge, over a time axis and a legend.
- **Colours:** under a dark or automatic theme the pane uses the design's fixed palette; under a light or ANSI theme it keeps the theme's colours. The theme is read at session start and on each change.

- **Plans** come from local `.crew/plans/*.md`, in filename order, while they have unfinished steps. A step line carries its dependencies (`after:`), which the tree reads.
- **States:** `queued` and `blocked` are left, `implementing` is running, and `verified`, `committed` and `skipped` are done. Any other state is counted as left and marked `?`.
- **Owners:** `main` and the helper types are shown; any other owner is shown as `?`.
- **Agent activity:** tool names come from a fixed set (a server's tool is `mcp`, any other `?`), never an input. Tokens and steps come from the host's usage on each step. A twin on the Codex helper runs in Codex's sandbox and reports no tools or tokens.
- **What it never does:** rendering reads only local in-memory state, without network or filesystem access (the theme is read from the settings menu at session start, not while drawing), and it never changes the crew mode or the status line. It needs no external tool.
- The tree's shape follows herdr-dagr (MIT OR Apache-2.0).

### Jev effort routing

`jevKey` turns Jev on: with a TypeSafe key there, Jev sizes the effort of each eligible helper call; with it empty, no Jev request or trust-settings read is made. Save the key in the plugin's config, which keeps it in secure storage:

```sh
read -rs k && printf '%s' "$k" | jq -Rs '{jevKey:.}' | claude plugin configure crew@spider-claude-mods --values-stdin; unset k
```

- **Bounds:** effort stays between medium and high, models stay at the role defaults or fixed twin ids, and the agent type is never changed (only the codex mode moves a call, to its own twin). Every helper defaults to high, so with a key Jev can lower a call to medium (depth below 3.0 on its 0-4 scale; within 0.01 of 3.0 keeps the default).
- **Key:** the `jevKey` option is the only source. It must be printable ASCII of at most 512 characters with no spaces. A `jevKey` that the repository's own settings declare is refused, a `HOME` they declare is ignored, and unreadable settings skip Jev requests.
- **Sent** to `api.typesafe.ai`: the agent name, the call description and the prompt with secrets, emails and paths removed and cut to 4000 characters.
- **Fallback:** any Jev failure (a request error, a 3 s timeout, the breaker, more than four calls at once, or a key/settings config failure) explicitly requests the role's default effort, high. An agent already past its first sent step keeps its effort, to preserve the host prompt cache.
- **Decision log:** with a key and a trusted home, each routed decision is a small v4 JSON file in `~/.claude/crew/decisions/` (see [Saved](#privacy-and-permissions)).

A `jevKey` that is not a string makes Claude Code refuse to load the whole plugin.

The `brainstorm` skill says how the main session plans a larger change: route the request (question, small, fix, change or contract; a route's own checklist loads only when it is taken), frame it, investigate (itself or with diggers), compare options, write one plan whose steps the main session owns, and ask you to approve it before implementing. A planner or a challenger call is optional, never a fixed step; the planner returns its steps in the plan's line format.

## Privacy and permissions

`jevKey` enables Jev routing; the `mode` option and `/crew-mode` choose whether plain calls run on the Codex twins. The key is kept in Claude Code's secure storage. A repository's own settings that declare `jevKey` turn Jev off, and settings that declare `mode` start the session in claude, so a repository cannot send your work to OpenAI.

- **Sent to Jev** (only with `jevKey` set, one request per eligible helper call, to `https://api.typesafe.ai/v1/systemone`): the agent name, the call's description and its prompt. Secrets in common shapes, emails and absolute paths are removed first, and the prompt is cut to 4000 characters. The key goes only in the `Authorization` header and is never logged. Calls that name a model, forks and workflow agents are not sent.
- **Saved:** with a key and a trusted home, a routed decision is one small JSON file in `~/.claude/crew/decisions/`. It holds the time, agent name, requested type, provider, depth, default/planned/applied effort, what the first step ran on, the Jev model id, the duration and a short non-cryptographic hash of the description. It never holds the prompt, description, key or a path. To delete the files: `rm -r ~/.claude/crew/decisions`.
- **Sent to OpenAI through the crew Codex helper** (with `codexLogin` on and the helper installed, for each step of a helper twin): the role's prompt with the repository path and date, the agent's request, and whatever Codex reads or runs inside its workspace-write sandbox with network access. The helper listens on a Unix socket only you can open; crew sends no token to it and returns command names and statuses, never their output. A helper twin's Context7 tool also sends the library name and question the model writes to `mcp.context7.com`, anonymously.
- **Sent through a gateway:** in the codex mode or on an explicit twin call behind a gateway, the twin's conversation, including what its tools read, goes to OpenAI through the gateway, with or without a `jevKey`.
- **Kept in memory/session state:** the resolved key and home, the effort book, pending confirmations, the breaker and registered twins; for twins on the login, each agent's type; the session's crew mode (`crew.mode`, readable by other plugins); and the HUD's plan and running-helper snapshots.

## Verification

```sh
claude plugin validate --strict plugins/crew
claude plugin test plugins/crew
mise exec -- tsc -p plugins/crew/tsconfig.json
node scripts/check-consistency.mjs
node scripts/check-version-bump.mjs origin/main
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/crew/helper/test/*.test.mjs
```

### Automated coverage

- **Helpers:** each helper's model, effort, shared tools and request-only write rule; the absence of every removed role; and the main session's section (it implements, no required subagent or review).
- **Write guard:** known crew helpers and twins may write; unknown crew types are held.
- **Twins and gateway:** the fixed-map twins, the gateway gate and partial registration failures.
- **Jev:** effort-only routing with the role-default fallback, first-step effort locking, breaker, key, decision log and confirmation.
- **Crew mode:** the mode from the option and `/crew-mode`, with and without Jev, and the calls it never moves.
- **Helper twins:** registration only when the helper is ready, with the gateway route preserved, the turn's request, caller and role for each of the three twins, polls and text, and failures. The helper's workspace-write lane with network access, thread registry, limits, interrupt and refusals run against a fake `codex app-server` (`helper/test`).
- **HUD:** plan states and owners, the running-helper rows and the pane's width handling.

Tests use the host with a fake `http.fetch` and a fake helper; nothing reaches Jev, OpenAI or a gateway.

### Live limits

Host and helper tests establish behavior against fakes. Writes and network access through the installed helper and all three twins in a real host session remain unverified; rerun `helper/install.sh` before that validation. Gateway execution also remains unverified. Using a Codex model in a session switches the auto-mode classifier to Claude Code's own (billed) requests for the rest of that session.
