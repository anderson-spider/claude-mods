# crew

Install in Claude Code:

```
/plugin install crew --marketplace anderson-spider/claude-mods
```

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
- **Sent** to `api.typesafe.ai`: the agent name, the call description and the prompt with secrets, emails and paths removed and cut to 4000 characters. See [Privacy and permissions](#privacy-and-permissions).
- **Fail open**: on a Jev error, a timeout (3 s) or more than four calls at once, Claude calls keep their model and effort. An explicit twin whose Jev request fails uses its fixed model with `:medium`, and automatic quota routing can still choose a twin with the same default suffix.
- **Thresholds**: a depth of 3.0 or more on Jev's 0-4 scale gives `high` effort, below it `medium`, and a depth within 0.01 of 3.0 keeps the agent's default; a tier answer applies from confidence 0.5. The decision log and the debug log are where to revisit them.
- **Decision log**: with a key set and a trusted home, each routed decision is also saved as a small JSON file in `~/.claude/crew/decisions/` (tier, confidence, depth, models, efforts, duration, a hash of the description, and an empty `outcome` for you to fill in; no prompt, description, key or path). The v2 schema keeps twin model fields canonical (no suffix). `bind: "suffix"` means a twin spawn succeeded with the effort suffix, including medium defaults; `applied.model` remains false, and `applied.effort` indicates a change from the default configuration, not observed execution. `ran` holds only API model/outgoing effort evidence. It stays on your machine and is never pruned: delete the folder to clear it. For example: `duckdb -c "select tier, effortApplied, count(*) from read_json_auto('~/.claude/crew/decisions/*.json') group by all"`.

A `jevKey` that is not a string makes Claude Code refuse to load the whole plugin (all five agents), not only the routing.

The plugin also ships a `brainstorm` skill that says how to plan with these agents: gather context with `code-reader` and `research` in parallel, let `architect` challenge the leading option, then write one plan, with each step's dependencies and files and the waves of steps that can run in parallel, before `developer` implements it. Once you approve the plan, it recommends `/goal`, `/loop` or direct execution, without starting any of them.

## Privacy and permissions

`jevKey` is the only option and enables Jev routing. With it empty, no Jev request or trust-settings read is made, but a session using a local HTTP loopback proxy can still register fixed-model Codex twins and route calls to OpenAI automatically. The key is kept in Claude Code's secure storage (the option is marked sensitive), not in a settings file for an installed plugin. Whether `$.config.list()` returns a sensitive value to other plugins is unverified. The key is checked once per activation, on the first request that needs it; a reload or key change resolves it again.

- **Sent to Jev** (only with `jevKey` set, one request per eligible `crew:*` Agent call, to `https://api.typesafe.ai/v1/systemone`): the agent name, the call's description and its prompt. Calls that name a model, forks and workflow script agents are not sent. Secrets in common shapes, emails and absolute paths are removed first (paths under the repository become relative, your home becomes `~`; when no home can be trusted, the user's home under `/Users` or `/home` in the session's directory stands in for it), and the prompt is cut to 4000 characters.
- **Read for Jev:** the `jevKey` option, project and local settings, and `HOME`, only when a key is set. The environment variables `TYPESAFE_API_KEY` and `JEV_API_KEY` and `~/.jev-router.env` are not read. A `jevKey` declared by the repository's settings disables Jev routing, not automatic quota routing. A `HOME` declared there is ignored (the home is also skipped when it is not absolute); unreadable settings disable Jev. A key that is not printable ASCII without spaces, or longer than 512 characters, is not used. The key is sent only in the `Authorization` header and is never logged.
- **Shown:** a switched call's task and notice name its provider and planned model/effort, with or without Jev. A routed subagent's first answered step produces a transcript line with the call's description and the model and effort observed on that step; like every transcript line it is also written to the debug log. For a routed Codex twin, crew requests bounded effort through an internal `<fixed id>:medium|high` spawn model suffix, never a caller override or a late effort-book bind. A real-host spike verified that both suffixes reached the outgoing request. Confirmation uses outgoing evidence, with suffix precedence over step effort; absent evidence confirms only the model and says the suffix was requested but effort is unobserved.
- **Saved:** with a key and a trusted home, routed decisions are written to one small JSON file in `~/.claude/crew/decisions/` (the home trusted for the key, never the repository's). The file holds the time, agent name, requested type, provider, quota reason/readings when available, tier, confidence, depth, default and final model, default/planned/applied effort, what the first step ran on (the API-reported model and observed outgoing effort, with suffix precedence, or null when unobserved), Jev model id, duration and a short non-cryptographic hash of the call description (a short, common description can be guessed from it); never the prompt, description, key or a path. The v2 schema keeps canonical twin model fields without suffixes; `bind: "suffix"` records a successful suffix-configured spawn, including a medium default. `applied` describes changes from the default request configuration, not observed execution. It stays on the machine and is never pruned. Without a trusted home no record is written; keyless quota routing does not start trusting `HOME` to save records. Decision debug lines contain no prompt. To delete the files: `rm -r ~/.claude/crew/decisions`.
- **Kept in memory/session state:** the resolved key and home, the effort book, pending confirmations, the breaker, registered twins and quota readings/decision. The router's `quota` atom is readable by other plugins. Module routing state resets on reload. Crew does not keep HUD state or save panel choices.

At `session.start`, crew reads `ANTHROPIC_BASE_URL` and registers twins only for an HTTP loopback URL (`127.0.0.0/8`, `::1` or `localhost`). The model map is fixed: code-reader/research use `gpt-6-luna`, designer/developer use `gpt-6.1-sol`, architect uses `gpt-6-astra`. There is no discovery request, model filtering or secret read at startup; the gate does not verify proxy identity or available models. A new session registers twins; `/reload-plugins` alone leaves them unregistered in the new activation.

Quota routing is automatic whenever twins are registered, independent of Jev. The first eligible spawn reads Claude's limits from the host and requests `GET /__ccmproxy/status?refresh=limits` from the validated local loopback base URL, using the `X-Ccmproxy-Token` line from `ANTHROPIC_CUSTOM_HEADERS`, under a 1.5-second deadline. Concurrent callers share one refresh; results and failures are cached for 60 seconds, and readings more than 15 minutes old are stale. No registered twins means no quota fetch. The host fetch has no no-redirect option: the initial destination is loopback, but redirect safety is not guaranteed by crew.

Only that `?refresh=limits` request may make the proxy read Codex usage from OpenAI (`wham/usage`), at most once every 5 minutes, with the ChatGPT login and no prompt; a plain status never does. The quota decision itself sends nothing to Jev. When Codex is chosen, the call becomes `crew:<role>-codex` and that subagent's conversation, including what its tools read and write, goes to OpenAI through the proxy. This can happen with `jevKey` empty. The proxy must serve the fixed models; unavailable models are not replaced with another model.

## Verification

```sh
claude plugin validate plugins/crew
claude plugin test plugins/crew
mise exec -- tsc -p plugins/crew/tsconfig.json
node scripts/check-consistency.mjs
node scripts/check-version-bump.mjs origin/main
```

### Automated coverage

Tests cover:

- Each Claude agent's model and effort, developer self-check reports and independent architect acceptance text.
- Fail-closed removed roles, fixed-map twins and the loopback gate, partial registration failures and write lanes.
- Jev routing: tier, effort, breaker, key, decision log and confirmation.
- Automatic quota routing both ways with and without Jev, including lazy quota fetches, deadlines and cache.
- Fixed-model effort suffixes and precedence, canonical v2 records, observed versus unobserved confirmation, first-step/spawn races and the fresh-activation gap before session start.

Tests use the host with a fake `http.fetch`; nothing reaches Jev, OpenAI or a real proxy.

### Live limits

Crew host tests establish routing and confirmation against fakes, not a real Codex account or the host's live reload lifecycle. Quota switching has been exercised against a local fake Codex, not a real account; the fixed-map registration and automatic startup behavior still need live verification. The Codex 5-hour veto, stale-reading rule and a real twin's tool use remain unverified live. A real-host spike against a local fake verified `gpt-6-luna:medium` and `:high` on outgoing subagent requests with the host's own effort still medium. Routed twins now request effort through that suffix, which the proxy gives precedence; the tag is request configuration, not evidence of backend execution. The proxy's contract suite separately observes translated `reasoning.effort`, suffix precedence and model-level clamping against a local backend fake. Multiple turns through the combined live host/crew/proxy path still require verification; host tests cover outgoing evidence, unobserved effort, normalization, mismatch detection and spawn/step races. There is no discovery request to verify proxy identity/model availability, and the existing quota fetch does not guarantee redirect safety.

Whether another plugin can read a sensitive option through `$.config.list()` remains unverified.
