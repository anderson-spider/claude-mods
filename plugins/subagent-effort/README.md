# subagent-effort

Sets the reasoning effort of every native subagent call from Jev's rating of its task. The model stays whatever the call or the agent definition says; only the effort changes. Local records let you compare what each effort costs in time and tokens.

```text
/plugin install subagent-effort --marketplace anderson-spider/claude-mods
```

## Setup

Set `JEV_API_KEY` where Claude Code inherits it (your shell profile for the terminal, `launchctl setenv` for the macOS desktop app) and restart Claude Code. A key declared in a repository's `.claude/settings.json` or `.claude/settings.local.json` is refused, so a repository cannot choose the account that receives your tasks. Without a usable key, subagents run at their usual effort and a toast says why, once per reason per load.

## How it routes

A hook on the `Agent` tool runs before each dispatch:

- **Any agent type** (built-in, yours or a plugin's): Jev rates how much reasoning the task needs, and the rating is the effort. Jev is the authority: its effort replaces one the call already carries. The effort shows beside the task's description in the transcript, with the one it replaced (`Find the router (low, was max)`).
- **Fork** (`subagent_type: "fork"`) or an empty task: passed untouched. The host ignores a fork's effort anyway.
- **Jev off or failing**: the call goes as it came, its own effort included, or the agent's usual effort when it has none, exactly as without the plugin.

The question asks Jev to judge the work itself, not the length of the brief. Its four levels are the efforts:

| Effort | Typical task |
| --- | --- |
| `low` | A lookup or mechanical step: find a file or symbol, list usages, read one function, run a known command. |
| `medium` | A bounded investigation or change in one area: trace one call path, summarize a module, a small edit with its test. |
| `high` | Reasoning across several parts or toward an unknown cause: debug a failure, review a multi-file change, plan a change that keeps contracts. |
| `xhigh` | Architecture, security, concurrency or deep domain reasoning. |

`max` is never picked. Jev answers with a probability per level, and the plugin takes the level with the lowest expected penalty, weighing spare effort 1.25 times missing effort. So a split judgment goes to the cheaper level: the higher of two adjacent levels wins only with more than 5/9 (about 56%) of their probability. This weighting is a policy choice, not a measurement; the records are there to check it.

A continuation through `SendMessage` is not an `Agent` call, so it keeps the effort it started with and is not recorded again.

## Records

Each decision records the effort the call came with and the one the agent runs with. `/subagent-effort-stats` says whether Jev is reachable in this session and summarizes the records: decisions by source (Jev, with how many replaced a different effort from the call, and Jev off with its reasons), and for each model family and effort (`haiku/low`, `opus/usual` when no effort was set) the runs, failures and median duration and tokens.

## Privacy

- **Sent to Jev** (`api.typesafe.ai`): the task text of each routed call, after paths under your home and the repository, email addresses, the key itself and secret-looking values are masked, cut to 4000 characters. Nothing is sent for a fork, an empty task, or when the key is missing.
- **Saved locally** in `~/.claude/subagent-effort/routes.jsonl` (one rotated generation past about 2 MB): ids, the agent type, the effort the call came with and the one applied, who decided it, Jev's confidence and latency, the brief's length in characters, and for each finished run its resolved model, status, duration and token count. Never the task, the prompt, the answer, a path or the key.

## Tests

Pure logic tests call the modules directly; host tests run the plugin against a fake host (`tests/host.ts`) with no network and no model calls, so they do not prove that Jev's ratings are good or that the host honors the effort. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
