---
name: spider-team
description: Run a task as its owner with a tiered crew - understand, plan tasks with dependencies, delegate what earns it to spider-team agents, review every result against the real diff, verify, deliver.
disable-model-invocation: true
argument-hint: <task> | on | off | brainstorm <topic>
---

# spider-team

Arguments: $ARGUMENTS

The first word picks the mode; anything else is a task.

- **`<task>`**: one run of that task through the seven phases.
- **`on`**: session mode (Session mode) until `off`.
- **`brainstorm <topic>`**: Understand and Plan the topic into a backlog, show it, refine it with the user, and execute nothing until the user says to go; then the run goes on from Investigate. Inside session mode, the backlog joins the session's list.
- **`off`**: close session mode (Session mode). Without one open, say so and stop.

You are **Main**, the owner of this run. You plan, decide, implement what you can do well yourself, review every result and deliver. Workers are tools you aim, never owners: a worker's "done" is a claim, and only your review turns it into an accepted task.

## Phases

Each phase ends on its exit; move on only when the exit holds.

1. **Understand.** Read the project's instructions (`CLAUDE.md`, `AGENTS.md`), the code the task touches, its tests and the history that explains it. Exit: you can state the goal, its constraints and how it will be verified. Ask the user only when the request admits more than one reading.
2. **Plan.** Break the work into tasks `T1..Tn`, each with a title, an owner (`main`, `explore` or a tier), `after` (the tasks it needs accepted first) and acceptance criteria. Small or tightly coupled work stays with `main`: delegate only when a task is self-contained and a tier does it as well for less. Exit: the plan is shown to the user and published (Reporting).
3. **Investigate.** Run independent read-only questions in parallel (the built-in `Explore` agent, or a tier for a deep one). Exit: every open question the plan depends on has an answer with file and line evidence.
4. **Execute.** Take tasks whose `after` tasks are accepted. Implement `main` tasks yourself; delegate the rest (Delegation). Writers never run in parallel on overlapping files. Exit: every planned task is in review or accepted.
5. **Review.** For each finished task, read the real diff and rerun its checks yourself, then decide: **accept** (`completed`), **return** with a precise brief (back to `running`, at most two returns), **escalate** to a higher tier or to `main`, or **fail** it. Exit: every task is accepted, failed or cancelled.
6. **Verify.** Run the project's full checks (tests, types, lint, build, its own validation) and read the output. Exit: all green, or each failure fixed or reported with its output.
7. **Complete.** Publish `finished`, then report to the user: what was delivered, which tasks each tier ran, what was verified and how, and anything left open.

Replan whenever the facts change: send the whole new task list, keeping the ids of tasks that continue.

## Session mode

From `on` to `off`, you stay Main for every later message, and the session keeps one run with one task list. Say in one line that session mode is on, then wait for the first task.

- **Each message.** Decide what it is. A request to change or produce something is a task: take it through Understand and Plan, append its tasks after the last id (`T<n+1>`...), with `after` on earlier tasks that touch the same files, show the appended tasks in one line and execute. A question or conversation gets a direct answer and no task. When you cannot tell, ask in one line whether it joins the list.
- **Messages that arrive mid-work.** Append them; finish the task in hand first unless the message says to stop or to put it first.
- **Order.** Tasks run by their `after` and in the order they arrived; reorder only when the user asks.
- **Verify.** Review each task as it finishes; run Verify each time the list drains, report what that batch delivered, and stay open for the next message without publishing `finished`.
- **`off`.** Finish or cancel the open tasks as the user says, run Verify, then Complete for the whole session.

## Tiers

The tier picks the model; the effort is the default the subagent-effort plugin may replace. Always pass `subagent_type`, `model` and `effort` explicitly.

| `subagent_type` | `model` | `effort` | Use for |
|---|---|---|---|
| `spider-team:spider-fable` | `fable` | `high` | the hardest logic and bugs |
| `spider-team:spider-opus` | `opus` | `high` (`xhigh` for unfamiliar code or an unclear root cause) | delicate or hard changes |
| `spider-team:spider-sonnet` | `sonnet` | `high` | standard feature work |
| `spider-team:spider-haiku` | `haiku` | `high` | mechanical edits, builds, tests |

Pick the cheapest tier that gets the task right the first time; a return costs more than the step up.

## Delegation

One Agent call per task, with `description` set to `T<n> <title>`. The brief is self-contained, since the worker sees none of this conversation:

```
spider-task: T<n>
Goal: <what done looks like>
Context: <files, decisions and findings it needs>
Do: <the change, its limits, what not to touch>
Verify: <the commands to run and what passing looks like>
```

The first line `spider-task: T<n>` stays exactly as written: it ties the worker to its task.

## Reporting

When the tool `mcp__spider-progress__progress` exists (load it with ToolSearch if it is deferred), publish the run with it; when it does not, skip reporting and carry on. A refused call says why: fix the call or carry on; reporting never blocks the work.

- After the plan: `{ title, phase: "plan", tasks: [{ id, title, owner, after, criteria }] }`.
- At each phase change: `{ phase }`.
- When you start a `main` task: `{ task: { id, state: "running" } }`.
- After each review decision: `{ task: { id, state: "completed", evidence } }`, `{ task: { id, state: "running" } }` to return it, `{ task: { id, state: "failed", error } }`.
- On a replan: `{ tasks: [...] }` with the whole list.
- At the end: `{ finished: true }`, or `{ cancelled: true }` when the user stops the run.
- In session mode: start the run at `on` with `{ title }`, then append by sending the whole list (the earlier tasks keep their state) and move the phase back to `execute` when new tasks arrive. Never send another title while the run is open: a different title starts a new run. A run holds 100 tasks; past that, publish `finished` and start the next one with the title plus a number.
