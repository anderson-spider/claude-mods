---
name: brainstorm
description: Use before creative or multi-step work (a feature, a refactor, a behavior change) to turn a request into an approved plan with a flow block through open discussion with the person.
---

# Brainstorm

Turn a request into a plan the person has approved, with a `pantheon-flow` block the controller can enforce. No code, no spec file: one plan.

## 1. Understand

- Read before asking. Dispatch the code-reader for code and the docs-reader for external docs, in parallel when both apply. Do not ask what the repository or the docs already answer.
- If the request holds several independent pieces, split it and plan the first one.
- If the request already states the acceptance criteria and the constraints, and one approach is clearly right, say so and go to the plan.

## 2. Explore and converge

- Put two or three approaches on the table with their trade-offs (cost, risk, how hard to undo, fit with the existing code), and say which one you recommend and why. If only one approach makes sense, say that instead of inventing others.
- Discuss it openly. Ask one question at a time, with your recommendation first and the reason; a choice is easier to answer than an open question, but follow the person where the conversation goes, and revisit an earlier answer when a new fact changes it.
- Converge: write the chosen approach back in a few lines (what the person said, what you assumed) and wait for a correction or a yes. Stop asking when the purpose, the constraints and the success criteria are clear.

## 3. Open the worktree

- Call `EnterWorktree` with a `name` taken from the topic. It creates the worktree and its branch in one step; do not create a branch separately. If the project's rules name branches differently, rename the new branch with `git branch -m` before the first commit.
- If the session already runs in a worktree, stay in it.
- With the default `worktree.baseRef` (`fresh`) the worktree starts from `origin/<default branch>`. Say so when the work depends on commits that are not on the remote.

## 4. Write the plan

- Path: `.pantheon/plans/YYYY-MM-DD-<topic>.md`. Add `.pantheon/` to the file printed by `git rev-parse --git-path info/exclude` (a worktree's `.git` is a file, so do not write to `.git/info/exclude` directly; create the line once); never commit the plan or touch a tracked ignore file.
- Sections, in order: **Context** (short), **Decisions** (what was agreed and why, the rejected approaches in a line each), **Tasks** and **Flow**.
- Under **Tasks**, one `### T<n>. <title>` per task with what the block cannot hold: the interfaces (signatures, types, contracts) it uses or exposes and any note the implementer needs. Goal, files, role, dependencies, acceptance and risk live once, in the block; do not restate them. No code in the plan.
- Under **Flow**, exactly one fenced block of JSON, as in this example (two tasks run in parallel after the first):

```pantheon-flow
{
  "schemaVersion": 1,
  "planId": "csv-export",
  "goal": "Users can export the report table as CSV from the toolbar.",
  "limits": { "maxBlocks": 6, "maxAttempts": 2 },
  "tasks": [
    {
      "id": "T1",
      "goal": "Add the CSV serializer; cells starting with = + - or @ are escaped.",
      "files": ["src/export/csv.ts", "tests/csv.test.ts"],
      "role": "developer",
      "dependsOn": [],
      "acceptance": { "checks": [{ "argv": ["npm", "test", "--", "csv"], "timeoutSec": 120 }] },
      "risk": true,
      "sideEffect": false
    },
    {
      "id": "T2",
      "goal": "Add the Export button to the toolbar.",
      "files": ["src/ui/Toolbar.tsx", "tests/toolbar.test.tsx"],
      "role": "ux",
      "dependsOn": ["T1"],
      "acceptance": {
        "checks": [{ "argv": ["npm", "test", "--", "toolbar"], "timeoutSec": 120 }],
        "criteria": ["The Export button sits at the right end of the toolbar and downloads report.csv with the visible rows."]
      },
      "risk": false,
      "sideEffect": false
    },
    {
      "id": "T3",
      "goal": "Document the export.",
      "files": ["docs/export.md"],
      "role": "developer",
      "dependsOn": ["T1"],
      "acceptance": { "checks": [{ "argv": ["grep", "-q", "report.csv", "docs/export.md"], "timeoutSec": 10 }] },
      "risk": false,
      "sideEffect": false
    }
  ]
}
```

What validation enforces; a typo fails at approval, so write the block carefully:

- Plain JSON: no comments, no trailing commas, no unknown fields anywhere. `schemaVersion` is `1`. `planId` is lowercase letters, digits and hyphens (up to 64, starting with a letter or digit); use the topic. `goal` is one sentence.
- `limits` is optional: `maxBlocks` 1 to 7 (default 6) and `maxAttempts` 1 to 10 (default 2).
- A plan has at most 100 tasks; a task at most 20 checks and 20 criteria; an argv at most 64 words; the block at most 256 KB.
- Each task has a unique `id` (`T1`, `T2`, ...), a `goal`, `files`, an `acceptance` and a `dependsOn`. `role` is `developer` (default; all code, UI code and logic included) or `ux` (only when the task is look and feel). No other role: the architect reviews through `risk` and QA verifies through `criteria`.
- `files` are the task's write ownership: paths or globs relative to the repository, no leading `/` and no `..`, never under `.pantheon`, `.git` or `.claude` (the flow's own state, git and the agent configuration), at most 50 per task. `dir/` covers everything under it, `*` stays within a path segment and `**` crosses segments. The implementer can write only there, so list the tests, fixtures and docs it needs. Tasks that run together must have disjoint `files`.
- `dependsOn` lists task ids that must be done first, with no cycles. Omitted, a task waits for the one listed before it; `[]` makes it a root. Write it explicitly on every task: parallel work needs it, and an inserted task silently changes an implicit one.
- `acceptance` needs at least one check or criterion. Prefer checks.
  - A check is `{ "argv": [...], "cwd"?: "...", "timeoutSec"?: n }`: an argv array, never a shell string (no pipes, globs, `&&` or substitution; put anything fancier in a script the task creates and run that). `cwd` is relative to the repository; `timeoutSec` is 1 to 600 (default 120). Pick checks that fail before the work and pass after it, and that are cheap to run again. The controller runs them when the task ends; a check that cannot run does not pass.
  - A criterion is a sentence QA can verify by running or using the result. Use criteria only for what no command can express (look and feel, behavior in the running app). A task with criteria is done only after a QA pass.
- `risk: true` for security, data integrity, shared contracts or hard-to-reverse changes; the task is done only after an architect review. Default `false`.
- `sideEffect: true` for a step that changes something outside the repository or cannot be repeated (deploy, publish, migration, sending). It needs at least one check and no criteria and no `risk`: verify and review in a task before it. It is recorded once and never run again.
- `onFail` (optional) is the id of another task to move to when this one runs out of attempts; that task must not be a dependency of anything, and at least one task must stay outside such branches. `loop` (optional) is `{ "maxIterations": 1 to 10 }` and replaces `maxAttempts` for that task. Leave both out unless the person asks for them.

## 5. Ask for approval

- Show the path and a short summary: the approach chosen, then each task with its role, checks and criteria. Do not paste the whole plan.
- Ask the person to review it and run `/pantheon flow approve <plan path>`. That command approves nothing yet: it lists every command that would run, the files each task may write and a 12-character hash, and the person confirms with `/pantheon flow approve <plan path> <hash>`. The approval records the block's hash and approves its checks, which the controller then runs by itself. You cannot run it for them: only the person's own typed command counts. If the command reports errors, fix the block and ask again; if the block changes after the listing, the hash is no longer the one printed and the person starts over.
- Editing the block never switches the controller off: it keeps running the version the person approved. It adopts an edit by itself only when the edit is purely additive: new tasks at the end of the list with `dependsOn` written out, no `onFail` and no `sideEffect`, an id never used before, files that overlap no task that is not done (and, when it overlaps finished work, `risk: true` on the new task, never over a finished `risk` task), no dependency on an active task, and checks that are commands a regular task of the plan already approved (same argv and `cwd`, a timeout not above; not an `onFail` branch's or a side effect's command); extra criteria, or extra checks that are an approved command, on a task that has not started; and a raised `risk`. Anything else (a new command, a longer timeout, a changed goal, role, files, `dependsOn`, `onFail` or limits, a removal) waits for `/pantheon flow approve`, and `/pantheon flow status` says why. An edit that mixes both waits as a whole.
- Do not run `execute` until the person has approved the flow or told you to run without one.
