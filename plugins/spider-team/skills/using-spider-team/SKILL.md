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
| `spider-team:developer` | Implement and test in its own worktree. | Write, Edit, Bash in the worktree. |
| `spider-team:reviewer` | Review a developer worktree and give APPROVED, CHANGES or BLOCKED. | Read-only plus git inspection. |

None of them delegates. Give each one self-contained brief: the authorized scope, repository, relevant evidence, constraints and acceptance criteria. If the project requires a tool they lack (CodeGraph, for instance), put its findings in the brief.

## Flow

1. Small or clear task: do it yourself or send it straight to developer.
2. Unknown ground: analyst first. Several files or contracts at stake: architect before developer.
3. Developer: the project's merged settings need `worktree.baseRef: "head"`, so the worktree starts from your HEAD; your uncommitted tracked edits are not in it, so commit a base first when they are prerequisites. Its answer names the worktree path and branch.
4. Reviewer: pass the developer's worktree path, branch and the acceptance criteria. Fix only what the review finds, within the user's authorization.
5. Independent pieces of work can run in parallel; a background launch is not completion, so wait for the result.

## Model and effort

Leave `model` and `effort` out and the plugin picks them: Jev assesses the task when `JEV_API_KEY` is in the user's environment, otherwise the role default applies (analyst haiku/medium, developer sonnet/medium, reviewer sonnet/high, architect opus/high). To choose yourself, set `model`/`effort` or put a profile in the brief: `@haiku-low`, `@haiku-medium`, `@haiku-high`, `@sonnet-medium`, `@sonnet-high`, `@opus-high`. Effort never goes above high. The README lists the dimension directives.
