---
name: brainstorm
description: Use before creative or multi-step work (a feature, a refactor, a behavior change) to turn a request into an approved plan with a flow block through open discussion with the person.
---

# Brainstorm

Turn a request into a plan the person has approved, with a `pantheon-flow` block the controller can enforce. No code, no spec file: one plan.

## 1. Understand

- Read before asking: code-reader for code, docs-reader for external docs, in parallel when both apply. Do not ask what they already answer.
- Split a request with several independent pieces and plan the first one. If the request already states the acceptance criteria and constraints and one approach is clearly right, say so and go to the plan.

## 2. Explore and converge

- Put two or three approaches on the table with their trade-offs (cost, risk, how hard to undo, fit with the code), and recommend one with the reason. If only one makes sense, say so instead of inventing others.
- Ask one question at a time, your recommendation first; revisit an answer when a new fact changes it.
- Converge: write the chosen approach back in a few lines (what was said, what you assumed) and wait for a correction or a yes. Stop asking when the purpose, constraints and success criteria are clear.

## 3. Open the worktree

- Call `EnterWorktree` with a `name` taken from the topic; it creates the worktree and its branch together, so do not create a branch separately. If the project's rules name branches differently, rename it with `git branch -m` before the first commit.
- If the session already runs in a worktree, stay in it. With the default `worktree.baseRef` (`fresh`) the worktree starts from `origin/<default branch>`; say so when the work depends on commits not on the remote.

## 4. Write the plan

- Path: `.pantheon/plans/YYYY-MM-DD-<topic>.md`. Add `.pantheon/` to the file printed by `git rev-parse --git-path info/exclude` (a worktree's `.git` is a file; create the line once). Never commit the plan or touch a tracked ignore file.
- Sections, in order: **Context** (short), **Decisions** (what was agreed and why, each rejected approach in a line), **Tasks** and **Flow**.
- Under **Tasks**, one `### T<n>. <title>` per task, holding only what the block cannot: the interfaces (signatures, types, contracts) and any note the implementer needs. Goal, files, role, dependencies, acceptance and risk live once, in the block. No code in the plan.
- Under **Flow**, exactly one fenced JSON block, as in this example (two tasks run in parallel after the first):

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

- Plain JSON: no comments, trailing commas or unknown fields. `schemaVersion` is `1`. `planId` is lowercase letters, digits and hyphens (up to 64, starting with a letter or digit). `goal` is one sentence.
- `limits` is optional: `maxBlocks` 1 to 7 (default 6), `maxAttempts` 1 to 10 (default 2).
- At most 100 tasks and 100 checks in all; per task at most 20 checks, 20 criteria and 50 files; an argv at most 64 words; the block at most 256 KB. Argv words, `cwd` and file patterns are plain text: no newline, tab, escape or text-direction character.
- Each task has a unique `id` (`T1`, `T2`, ...), a `goal`, `files`, an `acceptance` and a `dependsOn`. `role` is `developer` (default; all code, UI included) or `ux` (only for look and feel). The architect reviews through `risk` and QA verifies through `criteria`; no other role.
- `files` are the task's write ownership: repository-relative paths or globs, no leading `/` or `..`, never under `.pantheon`, `.git` or `.claude`. `dir/` covers everything under it, `*` stays in one path segment, `**` crosses segments. List the tests, fixtures and docs the implementer needs. Tasks that run together have disjoint `files`.
- `dependsOn` lists the task ids that must be done first, with no cycles. Write it on every task: omitted, a task waits for the one before it; `[]` makes a root.
- `acceptance` needs at least one check or criterion; prefer checks.
  - A check is `{ "argv": [...], "cwd"?: "...", "timeoutSec"?: n }`, an argv array, never a shell string (no pipes, globs, `&&` or substitution; put anything fancier in a script the task creates). `cwd` is relative to the repository and must exist when the check runs; a check that cannot run spends no attempt and does not pass (create the directory in the task, or leave `cwd` out); `timeoutSec` is 1 to 600 (default 120). Pick checks that fail before the work and pass after, and are cheap.
  - A criterion is a sentence QA can verify by running or using the result. Use criteria only for what no command can express (look and feel, behavior in the running app). A task with criteria is done only after a QA pass.
- `risk: true` for security, data integrity, shared contracts or hard-to-reverse changes: the task is done only after an architect review. Default `false`.
- `sideEffect: true` for a step outside the repository or one that cannot be repeated (deploy, publish, migration, sending). It needs at least one check, no criteria and no `risk`; verify and review in a task before it. It is recorded once and never run again.
- `onFail` (optional) is the id of the task to move to when this one runs out of attempts; that task is no one's dependency, and at least one task stays outside such branches. `loop` (optional) is `{ "maxIterations": 1 to 10 }` and replaces `maxAttempts` for that task. Leave both out unless the person asks.

## 5. Ask for approval

- Show the path and a short summary: the approach, then each task's role, checks and criteria; not the whole plan.
- Ask the person to review it and run `/pantheon flow approve <plan path>`. That approves nothing yet: it lists every command that would run (each word as a JSON string), each task's goal and files, and a 12-character hash; the person then confirms with `/pantheon flow approve <plan path> <hash>`. Only the person's own typed command counts; you cannot run it for them. If it reports errors, fix the block and ask again; if the block changes after the listing, the person starts over.
- Editing the block never switches the controller off: it keeps running the approved version. It adopts an edit only when the edit is purely additive: new tasks at the end, with `dependsOn` written out, no `onFail` or `sideEffect`, an unused id, files that overlap no unfinished task (or a finished one only with `risk: true` on the new task, never over a finished `risk` task), no dependency on an active task, and checks that are commands a regular approved task already runs (same argv and `cwd`, timeout not above); extra criteria, or extra approved checks, on a task that has not started; and a raised `risk`. Anything else (a new command, longer timeout, changed goal, role, files, `dependsOn`, `onFail` or limits, a removal) waits for `/pantheon flow approve`, and `/pantheon flow status` says why. An edit that mixes both waits as a whole.
- Do not run `execute` until the person has approved the flow or told you to run without one.
