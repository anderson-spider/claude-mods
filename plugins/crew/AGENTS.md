# crew

Registers six subagent types in `session.start`, each `crew:<name>` with a default model and effort and a tool allowlist. With the `jevRouting` option on, Jev (TypeSafe) may move a call's model and effort one step from those defaults.

| Agent | Default model | Tools | Role |
| --- | --- | --- | --- |
| `code-reader` | haiku | Read, Grep, Glob | finds and explains code; returns `path:line` summaries |
| `research` | haiku | Read, Grep, Glob, Edit, Write, WebSearch, WebFetch, Context7, terminal-browser and Claude in Chrome tools | researches docs and the web, browses pages, writes findings and docs |
| `designer` | sonnet | Read, Grep, Glob, Edit, Write, WebSearch, WebFetch, Context7, terminal-browser and Claude in Chrome tools | specifies the UI and edits styles and layout |
| `developer` | sonnet | Read, Grep, Glob, Edit, Write, Bash | implements a spec and runs its tests |
| `tester` | sonnet | Read, Grep, Glob, Edit, Write, Bash | reproduces, writes tests, runs the suite; never changes production code |
| `architect` | opus | Read, Grep, Glob, Write, Bash | plans and reviews; writes `.crew/**/*.md` only, never code |

## Layout

```
plugins/crew/
  .claude-plugin/plugin.json
  hooks/hooks.json            points to register.tsx
  hooks/register.tsx          $.agent.register in session.start, the Write/Edit guard, the agent.spawn and turn.step hooks of Jev routing
  hooks/agents.ts             SPECIALISTS: name, description, prompt, model, effort, tools; MODEL_FLOORS
  hooks/guard.ts              deniedWrite(type, path): the lane of each agent
  hooks/jev.ts                Jev client: one 3 s deadline, one retry, breaker, cap of 4 calls in flight
  hooks/questions.ts          the two questions (tier, reasoning_depth), the pinned Jev model and the thresholds
  hooks/routing.ts            which calls are routable, state for Jev, answers to model and effort, what moved and the notice text
  hooks/effort.ts             pending and bound effort per subagent id; `bind` returns what happened to the effort
  hooks/decisions.ts          decision log: the record, its file name, FNV-1a hash of the description; the write is injected
  hooks/key.ts                key sources and the repository-settings checks
  hooks/redact.ts             secrets, emails and paths removed from text before it is sent
  skills/brainstorm/SKILL.md  how to plan with the agents
  tests/                      a test file per module (`questions.test.ts` only checks the constants), plus the register tests through the host
```

In the project where the agents run, everything they write lives in an unversioned folder, which the brainstorm skill adds to `.gitignore`:

```
<repo>/.crew/
  plans/<name>.md       the plan the user approves (brainstorm, step 5)
  reviews/<name>.md     the architect's reviews
  research/<name>.md    the research agent's findings
```

## Brainstorm flow

`.crew/` ignored (step 0) -> frame -> `code-reader` and `research` in parallel -> options (`designer` first for UI) -> `architect` challenges the leading option -> plan in `.crew/plans/`, approved by the user -> recommendation of `/goal` (verifiable end), `/loop` (repeating or waiting work) or direct execution, never started by the skill -> `developer`, `tester`, `architect` audit. No edits happen before the approval.

## Jev routing

Off by default (`jevRouting`). On an `agent.spawn` of a `crew:<name>` type from `SPECIALISTS`, Jev answers one request with a `tier` choice (haiku, sonnet, opus) and a `reasoning_depth` score; the plugin rewrites `model` and, on the subagent's `turn.step`s, `effort`.

- The agent type is never rewritten: each agent keeps its lane and tools.
- Untouched, with no request: another type, a fork, a workflow script's agent (a hook can only refuse that spawn, so a rewritten model would be ignored: no model, no effort), a call that already names a model, `jevRouting` off, no key, a repository that declares `jevRouting` in its project or local settings (a debug log line says so once), and repository settings that cannot be read.
- Tier: applied from confidence 0.5, else the default. Model and effort are clamped to the default one step either way; the architect is never below sonnet (`MODEL_FLOORS`). Effort: depth under 1.0 low, under 2.5 medium, else high; a depth within 0.01 of a bound keeps the default. Thresholds are untuned.
- Fail open: no key, an error status, a malformed body, a timeout, an open breaker or a fifth concurrent call leave the call as it came. One 3 s deadline covers both attempts; a retry (429, 5xx, dropped connection) needs one second left.
- Key, in order: `$.env.get` of `TYPESAFE_API_KEY` then `JEV_API_KEY`, `~/.jev-router.env` through `$.fs`, the `jevKey` option. An environment key that project or local settings declare is ignored; so is `HOME` for the file when they declare it or when it is not absolute (redaction applies the same rule to the `~` it strips), and a `jevKey` they declare. The home is resolved once, with the key; when none is trusted, redaction takes `/Users/<name>` or `/home/<name>` from the session's directory (never the repository's `HOME`, and never to read a file) so the username and the dashed home still go. When those settings cannot be read routing is off completely. The key is resolved once per module life: a new key or file needs `/reload-plugins`. The key goes only in the `Authorization` header; errors and logs carry a status or a reason, never a body, a key or a prompt.
- Sent: the agent name, the call description and the prompt, with secrets, emails and paths removed, the prompt cut to 4000 characters, to `https://api.typesafe.ai/v1/systemone` with the model `jev-1.13.0`.
- Effort: every routable call has an entry under its type, description and spawning loop before the spawn continues, holding the default effort when Jev changed nothing or failed, so two calls alike with different efforts leave both on their defaults instead of trading them. A default entry only counts in that rule: it is never applied to a step, so a call that Jev changed nothing on or failed on keeps whatever `effort` the host sends. An unknown `agentId` on `turn.step` reads `$.agent.list()` once and matches it (an entry that names a parent matches only an agent of that parent, when the list gives one). The id is bound when the spawn resolves. Entries stay (64 at most) so a resumed subagent keeps its effort. The step is left alone when `e.effort` is absent. An id's effort never changes once a step has gone out (one exception, below), and a bind that runs while the list is being read is honored by the step that was waiting. An id that stepped before its effort was known (not listed yet, the list failing, every entry already taken, or ambiguous) keeps its default for its run, while an id stepping with nothing pending is not recorded at all (the one exception to that rule: an already-running agent of the same type and description with no entry of its own, such as one spawned with an explicit model or before `/reload-plugins`, can take a pending entry on its next step), and a bind that finds the id already on the entry's effort reports it as matched; a bind that finds its entry already matched by another agent's step leaves that agent as it is and gives the routed id the effort only if it has not stepped. Ids and entries are bounded by recency: a hit refreshes its place. Ids no list names (a workflow's agents, forks) are never kept in the book beyond the entries that are pending. Unverified live: that `turn.step` honours an `effort` above the default for a subagent, and whether the API charges a cache rewrite for a mid-run effort change (the rule above avoids asking).
- Rate limit: the cap of 4 counts requests, not deadlines. `$.http.fetch` cannot be aborted, so a slot stays held until its fetch settles even after the call failed open at the deadline, and for 60 s at most: a fetch that never settles frees its slot then (`SLOT_HOLD_MS`). The Jev model id in the log is kept only when it matches `[\w.:-]{1,64}`.
- Visibility: once the spawn resolves with an agent id (a refused spawn announces nothing), a `$.ui.notice` per decision and a debug log line with tier, confidence, depth, the effort that was applied (or the default), Jev model id and duration (never the prompt). An effort that was not applied (its entry lost the race to the first step, or was ambiguous) shows the default in the notice with "effort <x> not applied" and gets its own debug line with the outcome.
- Decision log: with `jevRouting` on (no option of its own), one JSON file per routed decision in `<trusted home>/.claude/crew/decisions/`, named `<ISO ts with ':' as '-'>-<agent id>.json`, written with `$.fs.write` where the notice is emitted, also when nothing changed (so keeps show), and not for a refused spawn or a call Jev failed on. The home is the one resolved with the key (`access.home`), never the repository's `HOME`; without one nothing is written and one debug line says so. The record (`v: 1`) has `ts`, `agent`, `tier`, `confidence`, `depth`, `defaultModel`, `model`, `defaultEffort`, `effortPlanned`, `effortApplied` (what the subagent runs on), `bind` (the effort book's outcome), `jevModel`, `durationMs`, `descriptionHash` (FNV-1a of the description: a non-cryptographic hash that a short, common description can be guessed from), `applied` and `outcome: null` for hand annotation; never the prompt, the description, the key or a path. The write starts before the notice and is awaited for about 1 s (`$.clock.after`, cancelled when it settles) before the spawn's result returns; it never rejects (a failure is one debug line), and one still pending then is one debug line, "decision write slow", and keeps running, so it cannot change the result or hold it. The host has no delete or append (`$.fs` has read, write, list, exists, stat), so the folder is not pruned: about 400 bytes of JSON, one file each (a disk block on most file systems). Unverified live: that `$.fs.write` is allowed under the home, outside the project (an `fs.*` hook may refuse it; the failure is only the debug line).

## Checks

- Before a change is done: `claude plugin validate plugins/crew`, `claude plugin test plugins/crew`, `node scripts/check-consistency.mjs`.
- Each agent's model and `effort` are asserted in `tests/agents.test.ts`; the lanes in `tests/guard.test.ts`; the denied and passed writes and the routing through the host in `tests/register.test.ts`.
- Routing: tier and effort mapping and clamps in `tests/routing.test.ts`; the client, deadline, breaker and cap in `tests/jev.test.ts`; key sources in `tests/key.test.ts`; the effort book in `tests/effort.test.ts`; redaction in `tests/redact.test.ts`; the decision record, its hash and path in `tests/decisions.test.ts`, and the log through the host (applied, kept, not applied, no secrets, no trusted home, a failing write) in `tests/register.test.ts`. Every test stubs `http.fetch`; none reaches the network.
- Live, with `claude --plugin-dir plugins/crew`: the six `crew:*` types are listed by the Agent tool, a write by the architect outside `.crew/` is denied, and `.crew` is ignored after a brainstorm. With `jevRouting` on and a key, a lookup-sized call to `crew:developer` shows a notice and the subagent runs on the chosen model and effort.

## Notes

- `effort` is set on purpose: Opus 5.5 and Haiku 5.5 default to `medium` and Sonnet 5.5 to `high`. Architect `high`, code-reader `low`, the rest `medium`.
- Prompts say what to do and why, not lists of prohibitions; keep new ones short and test a removal before adding a line.
- `hooks/agents.ts` is pure data (`SPECIALISTS`, `MODEL_FLOORS`); `hooks/register.tsx` holds the one `$.agent.register` call and every other `$` call, which it passes to pure modules as injected functions.
- Models are aliases (`haiku`, `sonnet`, `opus`), so they follow the newest model of each family. Routing moves a call between them and never to `fable` or a full id.
- `tests/agents.test.ts` checks the table; `tests/register.test.ts` runs `session.start` through the test host.
- Browser and MCP tool names are listed explicitly (no wildcard); one a session does not have connected is unavailable to the agent.
- Names stay short and avoid "advisor" and "architect" except for `architect` itself: Flightdeck shows the type (`crew:<name>`) on a narrow card and files any type matching its `architectPattern` under its architect panel, not as a card.
- `architect` is named so on purpose: it matches Flightdeck's default `architectPattern`, so its runs show in the ARCHITECT panel as consults, not as cards.
- `hooks/guard.ts` holds the write rules and `register.tsx` enforces them in a `tool.call` hook on `Write` and `Edit`: the architect may write Markdown under `.crew/` only (plans and reviews, unversioned; the brainstorm skill adds `.crew/` to the root `.gitignore` when it is not ignored), the tester test files only. The hook finds the caller through `e.agentId` and `$.agent.list()`, never blocks the main loop, and holds a subagent whose write it could not check.
- Not enforced, prompt only: the designer leaves logic and tests alone, and the architect's `Bash` is not screened for writes.
- `skills/brainstorm/SKILL.md` tells Claude how to plan with these agents (frame, gather in parallel, diverge, challenge with `architect`, plan); keep its agent names in step with `hooks/agents.ts`.
