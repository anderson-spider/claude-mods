# spider-team

Four native Claude subagents, with optional Jev model and effort selection. The session stays the lead; the host owns spawning, background delivery and worktree cleanup.

```text
/plugin install spider-team --marketplace anderson-spider/claude-mods
```

## Delegate

Invoke `/spider-team:using-spider-team` for the lead's workflow. Call the native `Agent` tool with one of these `subagent_type` values and a self-contained task:

| Type | Default | Access |
| --- | --- | --- |
| `spider-team:analyst` | haiku / medium | Read and investigate. |
| `spider-team:architect` | opus / high | Design changes and check invariants. |
| `spider-team:developer` | sonnet / medium | Implement and test in its own worktree. |
| `spider-team:reviewer` | sonnet / high | Review a developer worktree with read-only git commands. |

Each agent is a plain registered definition: role prompt, tool allowlist, default model and effort. All inherit the project instructions and the lead's permission mode. Analyst and architect get Read, Grep, Glob, LSP and Skill; reviewer also gets Bash, which its prompt limits to read-only git inspection; developer gets Write, Edit and Bash. None of them can call Agent, SendMessage, ToolSearch or the worktree tools. Each ends with a short answer for the lead: the outcome, findings with file:line evidence, open questions and checks.

Developer runs with `isolation: "worktree"` and requires the consuming project's merged settings to contain:

```json
{ "worktree": { "baseRef": "head" } }
```

Without it the call is refused with that instruction, since the worktree would start from another base. The plugin does not change settings. Tracked uncommitted lead edits are absent from the worktree. Worktree isolation does not sandbox every Bash operation.

## Model and effort

A hook on the `Agent` tool picks the model and effort of the four Spider types; every other agent type passes untouched. Effort is capped at high from every source.

- An explicit Agent `model` or `effort`, or a profile directive in the task, wins and skips Jev; omitted fields come from the role default. Model pins accept opus, sonnet and haiku; effort pins accept low, medium, high, xhigh and max, with xhigh/max sent as high. Other models and malformed or contradictory directives refuse the call.
- Otherwise, with `JEV_API_KEY` in the user's environment, Jev assesses difficulty, duration, scope and task type, and the closest profile below is chosen. A project/local settings declaration of the key, even empty, or unreadable settings turn Jev off.
- Otherwise, or when Jev fails, the role default applies. A failure inside the hook itself dispatches the call exactly as the lead wrote it.

| Directive | Pair | Difficulty / duration / scope | Rank |
| --- | --- | --- | --- |
| `@haiku-low` | haiku / low | 0 / 0.3 / 0.5 | 1 |
| `@haiku-medium` | haiku / medium | 1 / 0.9 / 1 | 2 |
| `@haiku-high` | haiku / high | 1.5 / 1.5 / 1.5 | 3 |
| `@sonnet-medium` | sonnet / medium | 2.5 / 1.5 / 2 | 4 |
| `@sonnet-high` | sonnet / high | 3 / 2.2 / 3 | 5 |
| `@opus-high` | opus / high | 4 / 3 / 3 | 6 |

The profile points are policy priors, not measured prices or benchmarks. Dimension directives are `!difficulty=0..4`, `!duration=0..3`, `!scope=0..3` and `!task_type=implement|bugfix|refactor|review|research|docs|test`; `!hard` means difficulty 3, `!long` duration 3 and `!quick` duration 0. Complete dimension pins select locally; partial pins ask Jev only for the rest. Recognized directives are removed from the task; quoted, escaped and fenced text stays intact.

Selection integrates expected penalties with under-capacity weight 4, over-capacity weight 0.5 and tolerance 0.5; dimension weights are 1, 1, 0.5 and 0.25, and lower rank breaks ties. Jev uses a fixed endpoint and model, one shared three-second deadline, bounded retries, a concurrency gate and a circuit breaker. The chosen pair goes to the debug log.

## Privacy and validation

Only the cleaned task goes to Jev: keys, secrets and paths are masked before the 4,000-character limit, and the key travels only in the Authorization header of the fixed endpoint. The plugin writes no files and keeps no session state.

The tests use a fake host and fake Jev; they prove the routing logic and wiring, not live model selection.
