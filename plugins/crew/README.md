# crew

Install in Claude Code:

```
/plugin install crew --marketplace anderson-spider/claude-mods
```

The main session does the work: it implements, edits files, runs commands and tests, reviews its own changes, commits and opens pull requests, on the model you chose for the session. Crew adds three optional read-only helpers it may call through the Agent tool, and nothing else; no task requires a subagent, and none of them is a review gate.

| Agent type | Model, effort | Tools | Role |
| --- | --- | --- | --- |
| `crew:planner` | Opus, high | Read, Grep, Glob | Plans complex or ambiguous work: decisions, dependencies, ordered steps, risks and acceptance criteria. |
| `crew:challenger` | Opus, high | Read, Grep, Glob | Questions a decision, design or change when an independent view adds value: premises, real risks, simpler options. Never a routine review. |
| `crew:digger` | Haiku, high | Read, Grep, Glob, Bash, WebSearch, WebFetch, Context7, CodeGraph and page-reading browser tools | Investigates code, git history, local docs, Context7, the web, GitHub, APIs and logs; returns evidence with paths and URLs, marked confirmed or inferred. |

Each helper answers only the main session: none has `Write`, `Edit` or `Agent`, so none changes files or delegates. Several diggers may run at once for independent questions. The previous roles (code-reader, research, designer, developer, architect) are gone; a `crew:` type that is not one of the three helpers or their twins has its `Write`/`Edit` held.

A hook also denies every `Write` and `Edit` of a crew helper or its twin, as a second wall behind the tool lists. It does not screen `Bash`: the digger is told to run only commands that change nothing, and on Claude that is prompt-level. Plans live in `.crew/plans/`, which the `brainstorm` skill adds to the repository's `.gitignore` when it is not ignored yet.

### The main session's section

In a request that offers the Agent tool (the main session; the helpers do not have it), a system prompt section says the main session implements and that the helpers are optional: the planner for complex or ambiguous work, the challenger only when an independent challenge adds real value, the digger for investigation. It asks for no helper on trivial work, no second call for what is settled, and the helper's summary rather than its transcript. With a `jevKey`, Jev sizes each helper call's effort. A teammate's prompt does not get the section.

### Native Codex twins

Each helper has a `crew:<role>-codex` twin on a fixed Codex model:

| Base role | Codex model |
| --- | --- |
| `planner`, `challenger` | `gpt-6-astra` |
| `digger` | `gpt-6-luna` |

A twin keeps its base role's prompt, tools and high effort. Never pass `model` to a twin: the call is refused rather than overriding its fixed model, and an unavailable model fails at the call instead of being replaced.

A twin registers at session start in one of three ways:

- **Codex login** (the `codexLogin` option): the planner and challenger twins, whose tools crew can describe, are answered by crew itself from the Codex backend. The digger twin runs through the crew Codex helper when it is installed and ready.
- **Gateway:** a gateway as `ANTHROPIC_BASE_URL` (any `http` or `https` URL other than `api.anthropic.com`) serves every twin not on the login. Crew sends the fixed ids with the gateway's `cx/` prefix (`cx/gpt-6-luna`), and the gateway must route them and their `-medium` and `-high` variants to an endpoint that serves Codex.
- **Neither:** with Anthropic's API as base URL and no login, no twin registers.

A new session registers twins; `/reload-plugins` alone (or an option change) leaves the new activation's registered set empty. When twins are registered, a separate prompt section lists them: call one for a user-requested Codex call or a second model family's view.

With a `jevKey`, Jev may size a twin's effort but never changes its model. Crew supplies `cx/<fixed model id>-<effort>` on the spawn. Any Jev request or config failure, and a codex-mode switch without Jev, uses the role default (`-high`). The task and notice show the `<model>/<effort>` request; the first answered step's transcript line confirms the API-reported model and the outgoing effort, or says the effort was unobserved.

### Codex twins on your Codex login (experimental)

With `codexLogin` on (under `--plugin-dir` a plugin's options live under `crew@inline`), the twins run on your ChatGPT Codex login with no gateway. It needs the Codex CLI signed in with ChatGPT (`codex login`). Crew reads the login from `~/.codex/auth.json` and never refreshes or writes it; when the access token is within a minute of expiring, the twin answers that the login has expired, and running `codex` once refreshes it.

**Planner and challenger twins: the backend path.**

- Crew's `turn.step` hook answers each step itself. It sends the subagent's conversation, the role's prompt and the schemas of `Read`, `Grep` and `Glob` to `https://chatgpt.com/backend-api/codex/responses` (`store: false`), and turns the answer into the step's text and tool calls.
- The tools run in Claude Code, under its permissions, and nothing of the step goes to Anthropic.
- A failure (no login file, an expired or refused login, a backend error or limit) answers the step with its reason and never moves it to Claude.
- Each step arrives whole rather than streamed. Codex's reasoning between steps is kept in memory per agent, and a reload drops it.

**Digger twin: the crew Codex helper.**

The digger runs shell commands, which crew cannot describe to the backend tool by tool, so its twin runs in `codex app-server`. A per-user helper owns the server: `helper/install.sh` installs the LaunchAgent `com.anderson-spider.crew-codex` and copies the helper to `~/.claude/mcp/crew-codex`, and `helper/uninstall.sh` removes it. Run `install.sh --check` first: it needs the ChatGPT app's `node`, a `codex` binary and `codex login`. Rerun `install.sh` after an update: helper 0.5.0 has only the digger lane, in a read-only sandbox.

- **One turn per step:** the twin's step sends the agent's last request to the helper. The helper runs it as a turn on that agent's Codex thread and returns the final text.
  - Where the host runs the agent as a subagent, it only delivers a result through `SubagentHandback`, so the final answer is returned as that call, a failure included. The planner and challenger twins do the same.
  - If the host asks for another step right after a handback with nothing new, the twin answers with the handed-back message and does not run again; a follow-up through `SendMessage` is a new turn on the same thread.
  - Helper twins send no usage, so they have no confirmation line or `ran` record. Codex's own commands never reach Claude Code.
- **The sandbox is read-only:** the thread works in the repository with Codex's `readOnly` sandbox, no network for commands and `approvalPolicy: never`, so any write fails inside Codex. The Context7 tool is the one network exit: it sends the library name and the question the model writes to `mcp.context7.com`.
  - The helper resolves the directory on every turn. It refuses the filesystem root, your home or a parent of it, and anything inside or containing `~/.codex`, `~/.claude` or the helper itself.
  - A repository with its own `.codex/config.toml` (or under a directory that has one, up to your home) is refused: Codex would load it and could run the programs it names outside the sandbox.
  - Web search is off, and commands run in a non-login shell with Codex's core environment. On the helper the digger reads the code and git history and has two MCP tools, Context7 and CodeGraph (below); the web needs the Claude digger or a gateway twin.
- **Isolated Codex home:** the server runs with its own `CODEX_HOME` (`~/.claude/mcp/crew-codex/state/codex-home`, mode 0700), holding only a link to your `~/.codex/auth.json`. Codex apps, plugins, hooks, computer use and browser use are disabled, so none of your Codex MCP servers or hooks load into a crew thread, and your Codex config is never read.
- **Two fixed MCP servers:** the helper declares `context7` (`https://mcp.context7.com/mcp`, anonymous, so with the service's anonymous rate limit) and `codegraph` (your `codegraph serve --mcp`, found under `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin`; left out when absent) itself, one `-c mcp_servers.<name>...` each. Nothing else is configurable. The CodeGraph tool needs the repository's `.codegraph/` index, and it runs outside Codex's sandbox, as you. Crew never reads or writes `auth.json`.
- **Shared limits:** at most four turns run at once, and a turn is stopped after fifteen minutes. A turn that does not stop within thirty seconds of an interrupt is abandoned with its thread. Threads are ephemeral and live until the cap or a restart.
- **Registration:** with `codexLogin` on, crew asks the helper's status once at session start, which starts nothing. When the helper is not ready, the digger twin is not registered on the login and one debug line says why; a gateway still serves it.

The option is off by default, and a repository's own settings that set it, or declare `HOME`, keep it off.

### Crew mode

The `mode` option (`claude` or `codex`, `claude` by default) is the mode every session starts in. `/crew-mode codex` or `/crew-mode claude` switches the running session, and `/crew-mode` alone toggles it; the option does not change. While the session is in codex the status line shows `crew: codex`.

In codex, a plain `crew:<role>` call goes to its registered twin, and a role without one stays on Claude. A call that names a model, a twin you named, a fork, a teammate and a workflow script's agent are never moved. The task and a notice name a switched call (`crew:digger -> Codex (crew mode) · gpt-6-luna · high`), and its work goes to OpenAI. A `mode` that the repository's own settings declare, or settings that cannot be read, start the session in claude.

### HUD band

The always-visible band above the prompt shows active plans by deliverable and running helpers. A deliverable row shows `done`/`running`/`left` with every running step's ID and owner (`main` or a helper). A helper row shows its requested or observed model, sent effort and elapsed time, and appears only while it runs.

- **Plans** come from local `.crew/plans/*.md`, in filename order, while they have unfinished steps.
- **States:** `queued` and `blocked` are left, `implementing` is running, and `verified`, `committed` and `skipped` are done. Any other state is counted as left and marked `?`.
- **Owners:** `main` and the helper types are shown; any other owner is shown as `?`.
- **What it never does:** rendering reads only local in-memory state, without network or filesystem access, and the band never changes the crew mode or the status line. There is no panel command.

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
- **Sent to OpenAI on the Codex login** (with `codexLogin` on, for each step of the planner or challenger twin, to `https://chatgpt.com/backend-api/codex/responses`): the role's prompt with the working directory and date, the subagent's whole conversation (file contents its tools read included) and the schemas of its tools. The access token goes only in `Authorization` and the account id in `Chatgpt-Account-Id`; the refresh token is never sent.
- **Sent to OpenAI through the crew Codex helper** (with `codexLogin` on and the helper installed, for each step of the digger twin): the role's prompt with the repository path and date, the agent's request, and whatever Codex reads or runs inside its read-only sandbox. The helper listens on a Unix socket only you can open; crew sends no token to it and returns command names and statuses, never their output. The digger's Context7 tool also sends the library name and question the model writes to `mcp.context7.com`, anonymously.
- **Sent through a gateway:** in the codex mode or on an explicit twin call behind a gateway, the twin's conversation, including what its tools read, goes to OpenAI through the gateway, with or without a `jevKey`.
- **Kept in memory/session state:** the resolved key and home, the effort book, pending confirmations, the breaker and registered twins; for twins on the login, each agent's type, its backend session id and Codex's encrypted reasoning; the session's crew mode (`crew.mode`, readable by other plugins); and the HUD's plan and running-helper snapshots.

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

- **Helpers:** each helper's model, effort and read-only tools; the absence of every removed role; and the main session's section (it implements, no required subagent or review).
- **Write guard:** every crew helper and twin is held on every path, and unknown crew types are held.
- **Twins and gateway:** the fixed-map twins, the gateway gate and partial registration failures.
- **Jev:** effort-only routing with the role-default fallback, first-step effort locking, breaker, key, decision log and confirmation.
- **Crew mode:** the mode from the option and `/crew-mode`, with and without Jev, and the calls it never moves.
- **Planner and challenger twins on the login:** registration, request body and headers, tool calls and kept reasoning, and every failure answered without reaching the API.
- **Digger twin on the helper:** registration only when the helper is ready, the turn's request, polls and text, and failures. The helper's read-only lane, thread registry, limits, interrupt and refusals run against a fake `codex app-server` (`helper/test`).
- **HUD:** plan states and owners, the running-helper rows and the band's width handling.

Tests use the host with a fake `http.fetch` and a fake login file; nothing reaches Jev, OpenAI or a gateway.

### Live limits

Host tests establish routing and confirmation against fakes, not a real Codex account. The helper's read-only digger lane was run live against the real Codex backend, outside the host: a digger turn ran `git log`, its `touch` in the repository was refused by the sandbox and no file was written, and a role with no lane was refused. The digger twin through a real host session, the twins behind a gateway and the backend path for the planner and challenger twins are verified against fakes only. Using a Codex model in a session switches the auto-mode classifier to Claude Code's own (billed) requests for the rest of that session.
