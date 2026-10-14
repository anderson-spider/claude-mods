---
name: using-spider-team
description: Lead a scoped project task with the native Spider Team agents (analyst, planner, reviewer) while the session itself implements and commits: which one to call, when, and in what order.
---

You are the lead and the only one who writes code. Decide the scope and acceptance criteria, implement, test and commit the work yourself, one task at a time, and use the agents below for investigation, planning and review.

## Agents

| Type | Use it to | Access |
| --- | --- | --- |
| `spider-team:analyst` | Investigate code, history or evidence and answer a question, cheaply. | Read-only. |
| `spider-team:planner` | Plan a change that touches several files or contracts (authentication, schema, API) as one Markdown plan with an acceptance checklist. | Read-only. |
| `spider-team:reviewer` | Review your branch and uncommitted changes and give APPROVED, CHANGES or BLOCKED. | Read-only plus git inspection. |

None of them writes files or delegates. Give each one a self-contained brief: the authorized scope, repository, relevant evidence, constraints and acceptance criteria. If the project requires a tool they lack (CodeGraph, for instance), put its findings in the brief.

## Flow

1. Small or clear task: implement it yourself, then go to review.
2. Unknown ground: analyst first, with the question and where to look.
3. Several files or contracts at stake: planner. It answers with one Markdown plan: goal and scope, ordered steps with the files each touches, invariants to preserve, an acceptance checklist of commands with their expected results, and assumptions or blockers. Save it if the task needs it; there is no other plan or run file.
4. Implement in your checkout (or in a worktree you create when the user's rules require one), run the checks and commit following the project's and the user's git rules.
5. Before the pull or merge request: reviewer. Pass the checkout path, the branch, the target branch, the acceptance criteria and the checks you ran. It reviews from the merge base with the target branch to HEAD, plus staged, unstaged and untracked files, and answers BLOCKED when it cannot inspect any of them.
6. Fix what the review finds, within the user's authorization, and review again: the final approval covers the complete diff. Pushing and pull or merge requests follow the user's rules.

A background launch is not completion: wait for the result before relying on it.

## Model and effort

Leave `model` and `effort` out of the `Agent` call: they are ignored and overwritten. The plugin picks the pair by one rule. When `JEV_API_KEY` is in the user's environment, Jev rates the task's difficulty and duration, a fixed table maps them to a pair (haiku/medium for trivial work up to opus/high for expert work) and the role's floor lifts a pair that is too weak (analyst haiku/medium, planner and reviewer opus/low). Otherwise, or when Jev fails, the role default applies: analyst haiku/high, planner opus/medium, reviewer opus/medium. There are no pins or directives in the brief, so write the brief for Jev to judge: the scope, the evidence and how hard and long the work is. The README has the table. `/spider-team-stats` summarizes the local routing records (runs, failures, the share of runs Jev judged short of their task, duration, cost, Jev confidence).
