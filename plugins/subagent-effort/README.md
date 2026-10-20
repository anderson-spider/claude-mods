# subagent-effort

Sets the reasoning effort of every native subagent call from Jev's rating of its task. The model stays whatever the call or the agent definition says; only the effort changes, and the transcript shows it in the task's description. Local records let you compare what each effort costs in time and tokens.

```text
/plugin install subagent-effort --marketplace anderson-spider/claude-mods
```

## Setup

Set the `apiKey` plugin option (a sensitive field, kept in secure storage) from the plugin's configuration in `/plugin`, in your user options. When the option is not set, the plugin uses `JEV_API_KEY` from the environment: set it where Claude Code inherits it (your shell profile for the terminal, `launchctl setenv` for the macOS desktop app) and restart Claude Code. A malformed option is reported, not replaced by the environment. A key that a repository's `.claude/settings.json` or `.claude/settings.local.json` declares for the source in use (`pluginConfigs` with this plugin's `apiKey`, or `env` with `JEV_API_KEY`) is refused, so a repository cannot choose the account that receives your tasks. Without a usable key, subagent calls go as they came and a toast says why, once per reason per load.

## How it routes

A hook on the `Agent` tool runs before each dispatch:

- **Any agent type** (built-in, yours or a plugin's): Jev rates how much reasoning the task needs, and the rating is the effort. Jev is the authority: its effort replaces one the call already carries. The effort shows beside the task's description in the transcript, with the one it replaced (`Find the router (low, was max)`).
- **Fork** (`subagent_type: "fork"`) or an empty task: passed untouched. The host ignores a fork's effort anyway.
- **Jev off or failing**: the call goes as it came, its own effort included, or the agent's usual effort when it has none, exactly as without the plugin.

Each Jev call has one 3-second deadline. A dropped connection, or a 429, 500, 502, 503, 504 or 529 response, is retried once while at least a second of the deadline is left. At most four Jev calls are in flight. After three failures in a row (a 400 or 422 rejection and an unreadable reply do not count), Jev is paused for five minutes, then one call goes through as a probe. While Jev is paused or the four slots are taken, a call goes as it came without a toast.

The question asks Jev to judge the work itself, not the length of the brief or its breadth: a very thorough survey of many files is longer, not harder. Its four levels are the efforts:

| Effort | Typical task |
| --- | --- |
| `low` | A lookup or mechanical step: find a file or symbol, list usages, read one function, run a known command. |
| `medium` | A bounded investigation or change in one area: trace one call path, summarize a module, map or inventory one area's code however thoroughly, a small edit with its test. |
| `high` | Reasoning across several parts or toward an unknown cause: debug a failure, review a multi-file change, plan a change that keeps contracts. |
| `xhigh` | Architecture, security, concurrency or deep domain reasoning. |

`max` is never picked. Jev answers with a probability per level, and the plugin takes the level with the lowest expected penalty, weighing spare effort 1.25 times missing effort. So a split judgment goes to the cheaper level: the higher of two adjacent levels wins only when the levels at or above it hold more than 5/9 (about 56%) of the probability. This weighting is a policy choice, not a measurement; the records are there to check it.

A continuation through `SendMessage` is not an `Agent` call, so it keeps the effort it started with and is not recorded again.

## Records

Each decision records the effort the call came with and the one the agent runs with, and the Jev call's own latency, the input and output tokens Jev reported and their estimated cost, apart from the subagent's duration and tokens. The cost charges input tokens at US$0.042 per million and output tokens at nothing, the published Jev rate as of October 2026 taken from gateway docs, so it is an estimate until an invoice confirms it. `/subagent-effort-stats` says whether this session has a usable Jev key and from which source it came (it sends no request to Jev), and summarizes the records: decisions by source (Jev, with how many replaced a different effort from the call, and Jev off with its reasons), the Jev calls with their median latency, tokens and estimated cost, and for each model family and effort (`haiku/low`, `opus/usual` when no effort was set) the runs, failures and median duration and tokens; a call that a hook or the permission check denied never ran, so it adds no run or failure (its decision still counts).

## Privacy

- **Sent to Jev** (`api.typesafe.ai`): the task text of each routed call, after paths under your home and the repository, email addresses, the key itself and secret-looking values are masked, cut to 4000 characters. Nothing is sent for a fork, an empty task, or when the key is missing, invalid or refused.
- **Saved locally** in `~/.claude/subagent-effort/routes.jsonl` (one rotated generation past about 2 MB): ids, the agent type, the effort the call came with and the one applied, who decided it, Jev's confidence, latency, reported tokens and estimated cost, the brief's length in characters, and for each finished run its resolved model (the model the call named when the host reports none), status, duration and token count. Never the task, the prompt, the answer, a path or the key.

## Tests

Pure logic tests call the modules directly; host tests run the plugin against a fake host (`tests/host.ts`) with no network and no model calls, so they do not prove that Jev's ratings are good or that the host honors the effort. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
