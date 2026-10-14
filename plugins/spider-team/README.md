# spider-team

Four native Claude specialists with optional Jev model and effort selection. The session remains the lead; the host owns spawning, background delivery and worktree cleanup.

```text
/plugin install spider-team --marketplace anderson-spider/claude-mods
```

## Delegate

Invoke `/spider-team:using-spider-team` for the lead's workflow. Call the native `Agent` tool with one exact `subagent_type` and a self-contained task:

| Type | Fallback | Access |
| --- | --- | --- |
| `spider-team:analyst` | haiku / medium | Read and investigate. |
| `spider-team:developer` | sonnet / medium | Implement and test in a native isolated worktree. |
| `spider-team:reviewer` | sonnet / high | Inspect a completed developer checkout with the restricted diff tool. |
| `spider-team:architect` | opus / high | Design changes and check invariants. |

All roles inherit project instructions and the lead's permission mode. Readers have explicit tool allowlists: Read, Grep, Glob, LSP, Skill and the report writer; reviewer also receives the diff tool. They cannot run shell commands or edit code. Developer receives Write, Edit and Bash. No role delegates to another agent, searches for additional tools, or sends messages. If a required project tool such as CodeGraph is unavailable, provide its exploration evidence in the brief.

Developer requires the consuming project's merged settings to contain:

```json
{ "worktree": { "baseRef": "head" } }
```

The plugin checks this setting and forces `isolation: "worktree"`; it does not change settings. Its base is the lead's captured HEAD. Tracked uncommitted lead edits are absent from the child checkout. If they are prerequisites, supply an adequate base before dispatching. An unchanged native worktree may be removed by the host; a `no-changes` receipt does not promise a retained checkout. Worktree isolation does not sandbox every Bash operation.

## Selection and limits

Without a usable Jev assessment, the exact role fallback above applies. With `JEV_API_KEY` in the user's environment, Jev assesses difficulty, duration, scope and task type. Any project/local settings declaration of the key disables assessment, including an empty declaration; unreadable settings also use the fallback. Routing does not alter role permissions or isolation.

Six automatic profiles are policy priors, not measured prices or benchmarks:

| Directive | Pair | Difficulty / duration / scope | Rank |
| --- | --- | --- | --- |
| `@haiku-low` | haiku / low | 0 / 0.3 / 0.5 | 1 |
| `@haiku-medium` | haiku / medium | 1 / 0.9 / 1 | 2 |
| `@haiku-high` | haiku / high | 1.5 / 1.5 / 1.5 | 3 |
| `@sonnet-medium` | sonnet / medium | 2.5 / 1.5 / 2 | 4 |
| `@sonnet-high` | sonnet / high | 3 / 2.2 / 3 | 5 |
| `@opus-high` | opus / high | 4 / 3 / 3 | 6 |

An explicit Agent `model` or `effort`, or a profile directive, skips Jev and fills omitted fields from the role fallback. Model pins accept opus, sonnet and haiku. Effort pins accept low, medium, high, xhigh and max; xhigh/max are always forwarded as high. Numeric budgets, Fable, inherit and opaque model aliases are refused. Pins can choose any of the nine low/medium/high pairs; only the six named profiles have `@` directives.

Dimension directives are `!difficulty=0..4`, `!duration=0..3`, `!scope=0..3` and `!task_type=implement|bugfix|refactor|review|research|docs|test`. `!hard` means difficulty 3, `!long` duration 3 and `!quick` duration 0. Complete dimension pins select locally; partial pins ask Jev only for remaining dimensions. Pair/profile pins take precedence over dimensions. Recognized directives are removed without rebuilding the rest of the task; quoted, escaped and fenced text stays intact. Contradictions, unknown directives and empty tasks are refused.

Selection integrates expected penalties with under-capacity weight 4, over-capacity weight 0.5 and tolerance 0.5. Dimension weights are 1, 1, 0.5 and 0.25; task-type affinities are neutral and lower rank breaks ties. Jev uses a fixed endpoint and model, one shared three-second deadline, bounded retries, a concurrency gate and a circuit breaker. Failures fall back before the single native Agent dispatch; a failed dispatch is never retried by routing.

Host compatibility is checked before assessment. Nonempty `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` or `CLAUDE_CODE_EFFORT_LEVEL`, remote isolation, and isolation requested for a reader block dispatch. Every child `turn.step` is classified by its own native ID and effective type from `agent.list`, independently of dispatch calls, parents, ordering or ID prefixes. For each of the four exact Spider types, every step accepts only opus/sonnet/haiku and low/medium/high. Fable, inherit, opaque or absent models and absent, numeric, xhigh or max effort return BLOCKED before inference, with usage null. A safe pair different from the forwarded pair passes and is recorded as an observed divergence when its dispatch context is available.

A session-local, versioned LRU cache retains at most 256 verified identities across compatible hot reloads. It stores types, never authorization of a model/effort pair. Verified external types pass untouched, even during a later listing failure; Spider cache hits recheck the pair on every step. A miss requires exactly one valid row for that ID. Missing, malformed or duplicate rows, unknown Spider namespace types and listing errors block. Eviction or an absent/incompatible cache requires a new lookup. Contradictory identity evidence invalidates the cached identity. The main loop, with no agent ID, passes unchanged.

The guarantee covers the **effective native type**, with stable, non-recycled identity within a session and a trusted hook chain that executes this guard. A rewrite to another type leaves the original role's jurisdiction: a rewrite to an external type passes, and a swap to developer follows developer's permissions. Hostile plugins, replaced role definitions, later `turn.step` hooks changing the pair, remote inference, calls outside `turn.step` and loops that skip this hook are out of scope. Internal/workflow IDs absent from the native listing are blocked. Reader tool restrictions are the host-enforced role specs, not permissions inferred from a dispatch call. Rejecting an explicit inherit pin does not establish the origin of an already resolved model.

Native dispatch runs once; cancellation before dispatch prevents it, and downstream denials and native errors are preserved without retries. Cancellation is owned by the host; telemetry completion never authorizes or disables inference. Decision writes are serialized, and a final blocked write cannot be replaced by a late pending snapshot.

## Reports and review

Report and diff authorization uses the caller's own verified native type. Reports are indexed by their author. Call context (including base and checkout) requires an exact link from the host's `agent.spawn` result to its tool-call ID. Missing or ambiguous links return a fixed BLOCKED error, including a synchronous report before spawn returns; the child never waits for that return. Parent, role, order and snapshots never select a call's context.

Every specialist calls `mcp__spider-team__report` with status, a short summary, verdict and a full Markdown body in `##` sections. Developer also supplies its absolute worktree path and branch when reporting `done`; the plugin verifies checkout, branch, repository and captured base. The caller never chooses the report destination or identity. Bodies are limited to 64 KiB, with at most sixteen sections. Invalid identities, traversal, symbolic destinations and failed writes produce no successful receipt.

The tool writes under `~/.claude/spider-team/reports/<session>/<agent>-<generation>.md` and returns a receipt containing status, path, report-id, verdict, summary and a section index with one-based offsets and line limits. Developer receipts also include checkout/branch/base. Repeating the same saved delivery is idempotent; changed content receives a new generation. The agent ends by copying that receipt verbatim. The lead reads only sections needed for the next decision, avoiding another copy of the full report in context. A long or changed final handback marks completion partial; short handbacks are a prompt contract, not a hard token cap.

Pass the developer receipt to reviewer. `mcp__spider-team__diff` accepts its report-id and an optional indexed filename, then checks the completed developer checkout. Running, failed, partial, missing or cleaned checkouts block review. The index lists committed changes, staged/unstaged changes and untracked files; request each tracked file's diff and use Read for untracked files in that checkout. Each page separates committed, staged and unstaged patches, including changes that cancel between the index and worktree. Git runs with fixed argv, no pager/fsmonitor/hooks/ext-diff/textconv. Oversized or truncated output is explicitly incomplete or refused. Reviewer inspects without fixing or running tests and distinguishes developer-reported checks from independently inspected evidence.

Background launch is not completion. Exact references survive compatible reloads in session state; `turn.complete` observes native delivery without another notification or polling the host output file. Failed or interrupted runs never become approved reviews.

## Privacy and validation

Telemetry retains at most 256 call records and independent child observations in total, including incomplete work, plus 128 compact author/report/context references. Completed call records are removed after delivery; blocked records are removed after their final write. Eviction waits for the current serialized write, and late completion or dispatch callbacks cannot recreate dropped entries. An expired context or report reference makes its receipt unavailable for diff; retained observations or report files never substitute for authorization. Report files are not deleted. Per-child observed pairs and turn-usage entries are also bounded; lost telemetry does not affect inference enforcement.

Only cleaned task text goes to Jev: key/secret/path masking happens before the 4,000-character limit, and the key appears only in the fixed endpoint's Authorization header. Local reports can contain code, paths and task evidence. Decision JSON under `~/.claude/spider-team/decisions/<opaque-session-namespace>/` keeps only normalized routing metadata, a noncryptographic task hash, validated dimensions, observed pairs, usage/duration/status, and `handbackChars`/`receiptChars`. A random namespace retained in session state separates identical tasks and counters across sessions; updates to one execution keep the same destination across reloads. JSON excludes prompts, task text, report/handback bodies, paths, native IDs, keys and raw errors. Usage updates are keyed by native turn and are not added again from synchronous completion.

The mirrored tests use injected fake I/O and a native host fake, with no live model/Jev calls. They establish offline logic, wiring and schema compatibility; fake tests do not prove real hook ordering or stable native identity. Live synchronous/background delivery, provider effort support, native worktree retention and quota savings still require real-session acceptance. Editing invariants and exact test citations are in [AGENTS.md](AGENTS.md).
