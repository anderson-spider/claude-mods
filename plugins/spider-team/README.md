# spider-team

Four native Claude subagents, with Jev model and effort selection. The session stays the lead; the host owns spawning, background delivery and worktree cleanup.

```text
/plugin install spider-team --marketplace anderson-spider/claude-mods
```

## Delegate

Invoke `/spider-team:using-spider-team` for the lead's workflow. Call the native `Agent` tool with one of these `subagent_type` values and a self-contained task:

| Type | Default | Access |
| --- | --- | --- |
| `spider-team:analyst` | sonnet / medium | Read and investigate. |
| `spider-team:architect` | opus / medium | Design changes and check invariants. |
| `spider-team:developer` | sonnet / high | Implement and test in its own worktree. |
| `spider-team:reviewer` | opus / low | Review a developer worktree with read-only git commands. |

Each agent is a plain registered definition: role prompt, tool allowlist, default model and effort (a cell of the table below, so editing the table moves the default). All inherit the project instructions and the lead's permission mode. Analyst and architect get Read, Grep, Glob, LSP and Skill; reviewer also gets Bash, which its prompt limits to read-only git inspection; developer gets Write, Edit and Bash. None of them can call Agent, SendMessage, ToolSearch or the worktree tools. Each ends with a short answer for the lead: the outcome, findings with file:line evidence, open questions and checks.

Developer runs with `isolation: "worktree"` and requires the consuming project's merged settings to contain:

```json
{ "worktree": { "baseRef": "head" } }
```

Without it the call is refused with that instruction, since the worktree would start from another base. The plugin does not change settings. Tracked uncommitted lead edits are absent from the worktree. Worktree isolation does not sandbox every Bash operation.

## Model and effort

A hook on the `Agent` tool picks the model and effort of the four Spider types; every other agent type passes untouched. One rule decides: Jev rates difficulty and duration, and a fixed table maps them to the pair. When Jev is unavailable or fails, the role default applies. Nothing else chooses the pair.

| Difficulty \ duration | short | medium | long |
| --- | --- | --- | --- |
| trivial (0) | haiku / low | haiku / low | haiku / medium |
| easy (1) | sonnet / low | sonnet / medium | sonnet / medium |
| moderate (2) | sonnet / medium | sonnet / high | sonnet / high |
| hard (3) | opus / low | opus / medium | opus / high |
| expert (4) | opus / high | fable / high | fable / high |

Difficulty levels 0 to 4 are the difficulty question's criteria; duration levels 0 to 3 are the duration question's, grouped as 0 or 1 short, 2 medium and 3 long. The table is fixed in `hooks/router.ts`, which also holds the level labels, the duration groups and each role's default cell; a new model is an edit of `MODELS` in `hooks/roles.ts` and of the cells, and the type-check fails on an unknown model or effort or a missing cell.

For each dimension Jev returns a probability distribution, and the level is the integer that minimizes the expected penalty: missing capacity weighs 2, spare capacity weighs 1, and ties go to the lower level. Grouping the duration happens after its level is chosen.

Why these cells, as a policy note and not a measured fact: in the published accuracy-versus-cost charts for Sonnet 5.5 and Opus 5.5, Opus at low effort costs about the same per task as Sonnet at high effort with similar results; Opus at medium looks like the best value for hard code; Opus above high stays flat or drops; Sonnet at max only pays off on long terminal runs and lowers merge quality. Haiku and Fable have no published numbers here, so they sit at the two ends.

- There are no pins and no directives. The `model` and `effort` fields of the `Agent` call choose nothing and are never refused: the hook overwrites them with the routed pair. Words in the task starting with an exclamation mark or an at sign are plain text that goes to Jev as written.
- Jev is always asked both questions, difficulty and duration. It needs `JEV_API_KEY` in the user's environment. A project/local settings declaration of the key, even empty, unreadable settings, a timeout, a malformed answer or any other failure turns Jev off for that call, and the role default applies.
- A task that is empty or only whitespace is refused.
- The chosen pair is appended to the call's description, so the transcript shows it beside the task, and goes to the debug log. A failure inside the hook itself dispatches the call exactly as the lead wrote it.

Jev uses a fixed endpoint and model, one shared three-second deadline, bounded retries, a concurrency gate and a circuit breaker.

## Privacy and validation

Only the redacted task goes to Jev: keys, secrets and paths are masked before the 4,000-character limit, and the key travels only in the Authorization header of the fixed endpoint. The plugin writes no files and keeps no session state.

The tests use a fake host and fake Jev; they prove the routing logic and wiring, not live model selection.
