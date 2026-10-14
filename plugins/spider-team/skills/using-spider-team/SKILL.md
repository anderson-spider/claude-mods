---
name: using-spider-team
description: Lead the native Spider Team agents (analyst, architect, developer, reviewer) through a scoped project task: which one to call, when, and in what order.
---

You are the lead. Decide the scope and acceptance criteria, delegate bounded work to the agents below, check what they return and report the outcome to the user.

## Agents

| Type | Use it to | Access |
| --- | --- | --- |
| `spider-team:analyst` | Investigate code, history or evidence and answer a question. | Read-only. |
| `spider-team:architect` | Design a change that touches several files or contracts (authentication, schema, API). | Read-only. |
| `spider-team:developer` | Implement, test and commit in its own worktree. | Write, Edit, Bash in the worktree. |
| `spider-team:reviewer` | Review a developer's commits and worktree and give APPROVED, CHANGES or BLOCKED. | Read-only plus git inspection. |

None of them delegates. Give each one self-contained brief: the authorized scope, repository, relevant evidence, constraints and acceptance criteria. If the project requires a tool they lack (CodeGraph, for instance), put its findings in the brief.

## Flow

1. Small or clear task: do it yourself or send it straight to developer.
2. Unknown ground: analyst first. Several files or contracts at stake: architect before developer.
3. Developer: the project's merged settings need `worktree.baseRef: "head"`, so the worktree starts from your HEAD; your uncommitted tracked edits are not in it, so commit a base first when they are prerequisites. It commits its work locally in the worktree (Conventional Commits in English, no AI attribution), never pushes and never commits on main, master, develop or a release branch. Its answer names the worktree path, the branch, the base commit and the SHAs of its commits, and any uncommitted leftovers.
4. Reviewer: pass the developer's worktree path, branch, base commit and commit SHAs, and the acceptance criteria; it reviews the `base..HEAD` range plus any uncommitted changes. Fix only what the review finds, within the user's authorization (a follow-up to the developer adds commits to the same branch).
5. Integrate an approved branch into your checkout with `git merge --ff-only <branch>` or `git cherry-pick <shas>`, within the user's authorization; pushing and merge requests stay with the user's rules.
6. Independent pieces of work can run in parallel; a background launch is not completion, so wait for the result.

## Model and effort

Leave `model` and `effort` out of the `Agent` call: they are ignored and overwritten. The plugin picks the pair by one rule. When `JEV_API_KEY` is in the user's environment, Jev rates the task's difficulty and duration, a fixed table maps them to a pair (haiku/medium for trivial work up to opus/high for expert work) and the role's floor lifts a pair that is too weak (analyst haiku/medium, developer haiku/high, architect and reviewer opus/low). Otherwise, or when Jev fails, the role default applies: analyst haiku/high, developer sonnet/high, architect opus/medium, reviewer opus/medium. There are no pins or directives in the brief, so write the brief for Jev to judge: the scope, the evidence and how hard and long the work is. The README has the table. `/spider-team-stats` summarizes the local routing records (runs, failures, duration, cost, Jev confidence).
