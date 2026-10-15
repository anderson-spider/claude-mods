# spider-team

Three native read-only Claude subagents (analyst, planner, reviewer), with Jev model and effort selection and local routing records. The session is the lead and the only one that writes code: it implements, tests and commits one task at a time, and calls the agents to investigate, plan and review. The host owns spawning and background delivery.

```text
/plugin install spider-team --marketplace anderson-spider/claude-mods
```

## Delegate

Invoke `/spider-team:using-spider-team` for the lead's workflow: do small, local work without agents; delegate only bounded questions with a purpose, at most two agents at once by default; verify what comes back; review when a risk calls for it; change approach after two attempts without progress; respect any stated budget without inventing usage figures; and deliver the result with the validation actually performed and what is pending. Call the native `Agent` tool with one of these `subagent_type` values and a self-contained task. For a follow-up on the same subject, continue the agent with `SendMessage` to its agent id instead of starting another: it keeps what it already read. A continuation is not an `Agent` call, so it is not routed again and the records do not count it.

| Type | Default | Floor | Access |
| --- | --- | --- | --- |
| `spider-team:analyst` | haiku / high | haiku / medium | Read and investigate code and git history. |
| `spider-team:planner` | opus / medium | opus / low | Plan a change as Markdown steps, invariants and acceptance checks. |
| `spider-team:reviewer` | opus / medium | opus / low | Review the lead's branch and uncommitted changes with read-only git commands. |

Each agent is a plain registered definition: role prompt, tool allowlist, and the default model and effort. All inherit the project instructions and the lead's permission mode. All three get Read, Grep, Glob, LSP and Skill; analyst and reviewer also get Bash for read-only git, which the plugin enforces (see [Read-only git](#read-only-git)). None of them can write files or call Agent, SendMessage, ToolSearch or the worktree tools, and none runs in a worktree. Each stays within the brief's scope, says so when the brief is unclear or the task is out of reach, and ends with a short answer for the lead: the outcome, findings with file:line evidence, limitations and open questions, the checks it ran and the next steps the lead needs. The analyst keeps it under about 250 words unless the brief asks for another format; the planner writes one line per step and the reviewer one line per finding.

### Read-only git

A `Bash` call from an analyst's or reviewer's loop runs only when it is one read-only git command: `git status`, `log`, `diff`, `show`, `merge-base`, `ls-files`, `blame` or `rev-parse`, optionally after `-C <dir>` or `--no-pager`. Anything else is refused with a message naming what is allowed: another program or subcommand, a chain, a pipe, a redirection, a substitution, an unquoted wildcard or brace, other global options such as `-c`, and the `--output` and `--ext-diff` options (or a prefix of them, which git also accepts). Quote patterns and revisions such as `'HEAD@{1}'`. The plugin learns an agent's type from the host's agent list, once per agent; when it cannot tell, the command is refused. The main session and every other agent run Bash as before.

### Planner

The planner answers with one Markdown plan and writes no file: goal and scope; ordered steps, one line each with the files it touches; the invariants to preserve, including authentication, schema and API contracts; an acceptance checklist of commands to run with their expected results; and assumptions or blockers. It names only paths, commands and host features it verified and marks anything it could not verify. The lead saves the plan when the task needs it; there is no other plan or run file.

### Review

The lead calls the reviewer when a change carries risk (behavior, architecture, a contract, security, several files, or a doubt the checks cannot settle), before opening the pull or merge request, with the checkout path, the branch, the target branch, the acceptance criteria and the checks it ran. The reviewer reviews the commits from the merge base with the target branch (`git merge-base <target> HEAD`) to HEAD, the staged and unstaged changes and every untracked file (`git ls-files --others --exclude-standard`), read in full, with read-only git commands. It judges the complete resulting diff, not only the latest fixes, and answers BLOCKED, naming the part, when it cannot inspect any of them. Its verdict is APPROVED, CHANGES or BLOCKED.

## Model and effort

A hook on the `Agent` tool picks the model and effort of the three Spider types; every other agent type, including the retired `spider-team:developer` and `spider-team:architect`, passes untouched. One rule decides: Jev rates difficulty and duration, a fixed table maps them to a pair, and the role's floor lifts the pair if the table gives less. When Jev is unavailable or fails, the role default applies. Nothing else chooses the pair.

| Difficulty \ duration | short | medium | long |
| --- | --- | --- | --- |
| trivial (0) | haiku / medium | haiku / medium | haiku / high |
| easy (1) | haiku / high | haiku / high | haiku / xhigh |
| moderate (2) | haiku / xhigh | sonnet / high | sonnet / high |
| hard (3) | opus / low | opus / medium | opus / high |
| expert (4) | opus / high | opus / high | opus / high |

Difficulty levels 0 to 4 are the difficulty question's criteria: trivial (a one-line or purely mechanical change), easy (a small, well-understood change in one place), moderate (needs some understanding of the surrounding code), hard (subtle logic across several interacting parts, or a root cause still to be found) and expert (architecture, concurrency, security or deep domain reasoning). The question asks Jev to judge the work itself, not the length or detail of the brief: a long list of constraints, checks or acceptance criteria does not make a task harder. The duration question asks how long an experienced engineer who already knows the codebase would need, because Jev cannot estimate a coding agent's own time and human-expert time is the standard scale (the SWE-bench Verified buckets). Duration levels 0 to 3 are under 15 minutes, 15 minutes to 1 hour, 1 to 4 hours and more than 4 hours, grouped as 0 or 1 short, 2 medium and 3 long. Each criterion of both questions carries a typical example of its level (a one-line layout adjustment with its test is easy and 15 minutes to 1 hour, for instance), so Jev rates against fixed anchors instead of the brief's wording. The policy sits in `hooks/router.ts`: the two questions sent to Jev, the penalty weights below, the level labels, the duration groups, the table, the ladder, each role's floor and default, and the prices. A new model is an edit of `MODELS` in `hooks/roles.ts`, the ladder and the cells.

The capacity ladder is the one ordered list of pairs the router may pick, weakest first:

```text
haiku/medium < haiku/high < haiku/xhigh < sonnet/high < opus/low < opus/medium < opus/high
```

Every table cell, floor and default must be an entry of the ladder, and the type-check fails otherwise. The routed pair is the stronger of the table's cell and the role's floor on the ladder; the default is used whenever Jev is off or fails, and is the model and effort of the registered definition. Defaults do not have to be table cells.

For each dimension Jev returns a probability distribution, and the level is the integer that minimizes the expected penalty: spare capacity weighs 1.25, missing capacity weighs 1, and ties go to the lower level, because spending less matters more than headroom. Between two adjacent levels the higher one wins only when it holds more than 5/9 (about 56%) of their probability, so a split judgment goes to the cheaper level. Grouping the duration happens after its level is chosen.

Why these cells, as a policy note and not a measured fact: Haiku 5.5 costs about a twentieth of Sonnet 5.5 per token and beats Sonnet at medium effort on merge-quality coding, so Sonnet at low and medium is dominated by Haiku at high and xhigh. Opus at low effort costs about what Sonnet at high does. Opus above high does not improve. Haiku is never run at low effort because it skips search and verification on long agentic prompts. Fable is left out for lack of data.

- There are no pins and no directives. The `model` and `effort` fields of the `Agent` call choose nothing and are never refused: the hook overwrites them with the routed pair. Words in the task starting with an exclamation mark or an at sign are plain text that goes to Jev as written.
- Jev is always asked both questions, difficulty and duration. It needs `JEV_API_KEY` in the user's environment. A project/local settings declaration of the key, even empty, unreadable settings, a timeout, a malformed answer or any other failure turns Jev off for that call, and the role default applies.
- A task that is empty or only whitespace is refused.
- The chosen pair is appended to the call's description, so the transcript shows it beside the task, and goes to the debug log. A failure inside the hook before dispatch runs the call with the role default pair, never with the lead's model and effort.

Jev uses a fixed endpoint and model, one shared three-second deadline, bounded retries, a concurrency gate and a circuit breaker.

## Local records and statistics

The plugin appends JSON lines to `~/.claude/spider-team/routes.jsonl` (the directory is created if missing; past about two megabytes the file moves to `routes.1.jsonl`, which replaces the previous one). Two kinds of line:

- A decision line, written when the pair is decided: the calibration it was made under (`calibration`, a number bumped whenever the questions, the penalty weights, the table or the role floors change; a line without it is calibration 1), time, tool use id, role, source (`jev` or `default`), the reason Jev was off, its latency, the levels, the top probability and the full distribution of each dimension (`dist`, every level's probability rounded to two decimals; null when Jev was not used), the table's raw cell, whether the floor applied, and the final model and effort, and the brief's length in characters (`briefChars`).
- An outcome line: for a foreground call, from its result (resolved model, number of models used, status, duration, input, output, cache creation and cache read tokens, and a cost estimate from the list prices of October 2026: per million tokens, Haiku 0.10 input, 0.50 output, 0.125 cache write, 0.01 cache read, valid for prompts up to 100k tokens; Sonnet 2, 10, 2.50, 0.10; Opus 4, 20, 5, 0.20). For a background launch the line is written when that agent's turn completes, with its duration, usage and end reason. For the reviewer only the verdict word (APPROVED, CHANGES or BLOCKED) is kept from its answer. Every outcome line also has `judge`, from the outcome judge below, and `answerChars`, the final answer's length in characters (what the lead reads back), null when the run did not complete.

Lines of the retired developer and architect roles still parse and keep their own groups in the stats. A line never holds the task, the prompt, an answer's text (only the two lengths), a path, a branch name or a key. The records stay on this machine, are read by nothing but the stats command, and a failure to write one never changes a dispatch.

`/spider-team-stats` prints a compact summary per role and per final pair: runs, failure rate (error, abort or refusal, plus CHANGES or BLOCKED for reviewer runs), `short=` the share of judged runs the judge found short (`-` when none was judged) and `judged=` how many were judged, median duration, total tokens and estimated cost; the share of default fallbacks with their reasons; the distribution of Jev's top confidence; and, for each predicted human-time level, how many current-calibration runs it was joined to and their median real agent duration. Last, per role and in total, it compares the routed pairs with each role's default pair: how many runs with usage went below, at or above the default on the capacity ladder, what their tokens cost at the routed model and what the same tokens would have cost at the default model, and the difference as `saved=` or `extra=` with its share of the default cost. The section's heading says it is a price comparison, not measured savings. Only the model's price is compared: effort changes how many tokens a run spends, and how many it would have spent at another effort is not known, so a run that changed only the effort counts as no difference. The Jev confidence and that section use only decisions of the current calibration, and one line says how many decisions from older calibrations they left out (no line when there are none); the per-role and per-pair groups and the fallback share count every record. The last section gives, per role, the median and 90th percentile of the brief and answer lengths in characters, with how many lines measured each (lines from before the fields measure nothing). The command is named `spider-team-stats` because a command name cannot hold a colon and `stats` belongs to the host.

### Outcome judge

The outcome judge labels whether the routed pair was enough. When a run completes with a non-empty final answer, Jev is asked three yes/no questions (Noul, where a high probability is yes) about that answer, sent as the state field `report.text`:

- `finished`: does it say the agent completed everything it was asked to do?
- `failingChecks`: does it report a failing test, check or build that it left unresolved?
- `blocked`: does it say the agent stopped, was blocked, or needs help or a decision before the work can be finished?

The outcome line keeps only the three probabilities, rounded to two decimals, as `judge: { finished, failingChecks, blocked }`. A run is judged short of its task when `finished` is below 0.5 or `failingChecks` or `blocked` is above 0.5 (`JUDGE_FIRE` in `hooks/router.ts`, beside the questions). Errored, refused and aborted runs and empty answers are not judged and get `judge: null`. The `judgeEvery` plugin option sets how often the judge runs, since each judged run is one more Jev request: 1, the default, judges every completed run with an answer, N judges the first and then one in N, and 0 turns the judge off; a run left out also gets `judge: null`, and the stats count only judged runs. The count starts over when the plugin reloads. So does every judge failure: no key, a key the repository's settings declare, unreadable settings, a timeout, a malformed answer or anything else. A failed judge still writes the outcome line and logs one fixed debug line with the reason code. The judge uses the same client as routing, with the same endpoint, model, key rules, deadline and retries, but its own concurrency gate and circuit breaker, so a slow or failing judge never turns routing off. Its questions do not route, so they leave the calibration unchanged. The judge never holds a result: the `Agent` result (or a background agent's end) passes on at once, and the outcome line is judged and written after it. A plugin reload drops an outcome still waiting on the judge.

## Privacy and validation

Two texts go to Jev, both redacted the same way: the task, for routing, and a completed agent's final answer, for the outcome judge. In each, the key, secrets and paths are masked across the whole text before it is cut to the 4,000-character limit, and the answer is the judge's only state. The key travels only in the Authorization header of the fixed endpoint. Neither the answer, its redacted form nor Jev's reply is written to the records or the debug log. The one file the plugin writes is the local routing record above; it keeps no session state beyond two bounded in-memory maps: background agents waiting for their end, and the role of each agent the Bash guard has looked up.

The tests use a fake host, a fake file system and fake Jev; they prove the routing and judging logic and wiring, not live model selection or live judgments.

## Credits

Inspired by [JevFlow](https://github.com/Parth1811/JevFlow) by Parth Patil (MIT), which asks Jev whether an agent's work is really done. The outcome judge follows that idea, and the Jev client began as a port of JevFlow's `jev_client.py` before it was rewritten for the TypeSafe endpoint.
