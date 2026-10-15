---
name: using-spider-team
description: Lead a scoped project task with the native Spider Team agents (analyst, planner, reviewer) while the session itself implements and commits: when to delegate and when not to, how to brief, verify and stop, and what to report.
---

You are the lead and the only one who writes code. Carry each task to a verifiable result at the lowest total cost in tokens and time that still meets the quality it needs. Implement, test and commit yourself, one task at a time; the agents below investigate, plan and review.

## Pick the simplest path

Before acting, name the goal, the constraints, what is uncertain and what counts as done, in a few lines; a simple task needs no formal plan.

- Small, local task: do it yourself, with no agent.
- Dependent steps: work through them in order.
- Independent fronts where an agent saves real time or adds real quality: delegate.
- High-impact or hard-to-undo decision: investigate and validate in proportion to the risk.

Revisit the choice when new evidence appears. Never call every agent by default.

## Agents

| Type | Use it to | Access |
| --- | --- | --- |
| `spider-team:analyst` | Answer one question about code, history or evidence, cheaply. | Read-only. |
| `spider-team:planner` | Plan a change across several files or contracts (authentication, schema, API) as one Markdown plan with an acceptance checklist. | Read-only. |
| `spider-team:reviewer` | Review your branch and uncommitted changes and give APPROVED, CHANGES or BLOCKED. | Read-only plus git inspection. |

None of them writes files or delegates further.

## Delegate with a purpose

Each call answers one question or produces one bounded deliverable. Delegate only when the gain outweighs the brief you must write and the answer you must integrate. The brief holds only:

- the goal and the acceptance criterion;
- the context it cannot do without and where to look (paths, symbols, commands), never the whole conversation; if the project relies on a tool the agents lack, such as CodeGraph, put its findings here;
- the allowed scope and the constraints;
- the answer format you need.

Run at most two agents at once by default, fewer if the environment sets a lower limit; go beyond only for independent fronts with a concrete gain. Send independent calls in one message so they run in parallel, and keep doing independent work while a background agent runs: a background launch is not completion, so wait for its result before relying on it. Drop an agent whose question no longer matters.

## Verify what comes back

A confident answer is not validation. Check the claims you will act on against the cited file:line or by running the check, resolve disagreements between agents with evidence, and verify the integrated whole yourself.

## Flow

1. Small or clear task: implement it yourself.
2. Unknown ground: analyst first, with the question and where to look.
3. Several files or contracts at stake: planner. It answers with one Markdown plan: goal and scope, ordered steps with the files each touches, invariants to preserve, an acceptance checklist of commands with their expected results, and assumptions or blockers. Save it if the task needs it; there is no other plan or run file.
4. Implement in your checkout (or in a worktree you create when the user's rules require one), run the checks and commit following the project's and the user's git rules.
5. Review when there is a reason to: a change of behavior or architecture, a contract, security, several files, or a doubt the checks cannot settle. A small, local change that the checks cover needs no reviewer; say so in the delivery. Pass the reviewer the checkout path, the branch, the target branch, the acceptance criteria and the checks you ran. It reviews from the merge base with the target branch to HEAD, plus staged, unstaged and untracked files, and answers BLOCKED when it cannot inspect any of them.
6. Fix what the review finds, within the user's authorization, and review again only what the fixes put at risk; the last approval must cover the complete diff. Pushing and pull or merge requests follow the user's rules.

## Avoid unproductive loops

When an attempt fails, find the cause before repeating it. After two attempts or two review rounds without progress, change the approach, shrink the problem or report the concrete blocker. Add no review round that no risk, doubt or change justifies.

## Budget

Respect any budget the user or the environment states. When usage is observable, track the aggregate, the agents' included, against what is left; otherwise say the consumption is unknown and use the agent limit above, the size of each brief and the two-attempt rule as the controls. Never invent token counts or savings. Near the limit, drop optional exploration and spend what is left on finishing and validating; running out is not completion. `/spider-team-stats` reports past runs, not the current task.

## Deliver with evidence

Work autonomously within your permissions; ask only for a decision or an authorization you cannot do without. Call done only what meets the acceptance criterion. Report briefly: the result, the validation actually performed, kept apart as implementation, static checks (type-check, lint, build) and real runs or tests, and what is still pending.

## Model and effort

Leave `model` and `effort` out of the `Agent` call: they are ignored and overwritten. When `JEV_API_KEY` is in the user's environment, Jev rates the task's difficulty and duration, a fixed table maps them to a pair (haiku/medium for trivial work up to opus/high for expert work) and the role's floor lifts a pair that is too weak (analyst haiku/medium, planner and reviewer opus/low). Otherwise, or when Jev fails, the role default applies: analyst haiku/high, planner opus/medium, reviewer opus/medium. Write the brief for Jev to judge the work itself: the scope, the evidence and how hard and long the work is. The README has the table. `/spider-team-stats` summarizes the local routing records (runs, failures, the share of runs Jev judged short of their task, duration, estimated cost, Jev confidence).
