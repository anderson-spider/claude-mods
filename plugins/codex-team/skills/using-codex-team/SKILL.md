---
name: using-codex-team
description: Turns this session into the tech lead of a Codex team in Herdr (developer, analyst, architect, reviewer) until the session ends.
disable-model-invocation: true
---

# Using the Codex team

## 0. Herdr check

Run `test "${HERDR_ENV:-}" = 1`. When it fails, answer only: "codex-team can only be used inside a Herdr pane." and stop: this skill does nothing more in that session.

## Your role from now on: tech lead

The team works on its own Codex quota; you spend yours on judgement. For the rest of the session you plan, dispatch, read reports, decide with the user and ship. The team does the reading, the investigation, the design and the code:

- **Every lookup goes to the analyst**, however small: code, history, docs, binaries, the web. You read reports, plans, verdicts and the diff lines a verdict points at.
- **You write two kinds of file**: the plan under `.crew/plans/`, and a change the user asks you to make yourself.

| Role | Hand it | Agent and tab |
| --- | --- | --- |
| `developer` | implementation and tests, left uncommitted; corrections after review | `dev-<slug>`, in the task tab `codex · <slug>`, working in the task worktree (`cwd`) |
| `analyst` | investigation, documentation drafts | `analyst` in the `codex team` tab, a fresh Codex per dispatch; `analyst-<slug>` in the task tab while the shared one is busy |
| `architect` | design, trade-offs, ordered steps | `architect` in the `codex team` tab, a fresh Codex per dispatch |
| `reviewer` | the review of a finished developer task | `architect-<slug>` in the task tab, always `xhigh`; the plugin writes its brief |

Drafts from the analyst go to the developer to apply: one writer per worktree.

`mcp__codex-team__finish` with `{ agent }` ends a settled agent: it closes its pane (the task tab goes with its last pane) and archives its Codex session. It refuses an agent that is working or blocked.

## 1. Start or resume

Run this on activation, and again whenever you lose the thread (after a compaction, a reload or a long pause), before any other action:

1. Read the active plan: the newest `.crew/plans/*.md`. Its `## Dispatches` section (step 6 of Dispatch) is your memory of what is out.
2. Run `herdr agent list` and reconcile: every `## Dispatches` line still open names its agent and report; read the reports that came back since, and handle them (section 4). An `unknown` delivery stays unknown: check `herdr agent get <agent>`, never resend.
3. Start a background `herdr agent wait` for every open dispatch whose agent is still live and has none running.
4. Open the plan pane when it is not open, pointed at the session root (the directory holding `.crew/`, never the shell's current directory): `herdr plugin pane open --plugin herdr-dagr --entrypoint dagr --placement split --direction right --target-pane "$HERDR_PANE_ID" --cwd <root> --env DAGR_RUN=<root>/.dagr/run.json --no-focus`. The plugin keeps `.dagr/run.json` current from the plan; `.dagr/` stays out of git.

Done: every open `## Dispatches` line has either a report you handled or a live agent with its wait running.

## 2. Every request becomes a step first

Before acting on any request of the user, write it into the plan as a step of its own, with its owner and `state:`. A request folded into another step's text does not count: the user follows the work in the plan pane and sees only steps. Then act.

- **Small** (a one-line change, a single lookup, a question): one step, then dispatch it.
- **Larger** (several files, a design choice, a PR): plan it in `.crew/plans/<slug>.md` (format below), with each step on its real owner, and ask the user to approve the plan before the first developer dispatch. The plan replaces Claude's plan mode.

### Plan format

The pane reads this format and nothing else:

```markdown
## Steps

### <deliverable title, one per PR>

- <kebab-id> (<owner>, after: <ids or —>) <action and files> — state: <state>[ (<note>)]
```

- Each `###` heading with steps is a deliverable, shown as `T1`, `T2`… in plan order with its title.
- Step ids are descriptive kebab-case (`jev-client`, `fast-mode`, `pr-jev`), unique in the plan.
- Owner is who really does the step: `main` (you), `dev-<slug>`, `analyst`, `analyst-<slug>`, `architect`, `architect-<slug>`, `git-master`. When the plugin falls back to `analyst-<slug>`, change the owner to the agent that really took it.
- State: `queued`, `implementing`, `blocked` (the note names what unblocks it), `verified` (its acceptance was checked; the note says by what), `committed` (in an open or merged PR), `skipped`.
- A deliverable ends with its PR step, owned by `git-master` (the subagent runs in your session, so the pane shows it on your pane).

Update a step's `state:` the moment it changes: on dispatch, on return, on review, on merge.

After `## Steps`, keep a `## Dispatches` section, one line per dispatch, written when you call `dispatch` and closed when you handle its return:

```markdown
- <step-id>: <agent> slug=<slug> report=<path> delivery=<status> — open|closed (<outcome>)
```


## 3. Dispatch

1. **Worktree (developer only).** Create it from the base branch beside the repository: `git worktree add -b <branch> ../<repo>-<slug> <base>`. Pass its absolute path as `cwd`; follow-ups on the same task reuse the same `slug` and `cwd`.
2. **Brief.** Write `task` self-contained: the agent has none of this conversation. Name the goal, the files or area, the rules that apply, what done means (the checks that must pass) and what stays out of scope.
3. **Call** `mcp__codex-team__dispatch` with `role`, `task` and `slug` (at most 22 characters), plus `cwd` for the developer. Pass `effort` only when the user asks for one; otherwise Jev or the role default decides.
4. **Delivery.** `confirmed`: go on. `unknown`: never send it again; check `herdr agent get <agent>` and wait. `not_sent`: fix the reason it gives, then dispatch again.
5. **Wait in the background:** `herdr agent wait <agent> --timeout 3600000` with `run_in_background: true`, one per dispatched agent. Notifications come back one by one; handle each as it arrives.

6. **Record** the dispatch as an `open` line in `## Dispatches` (agent, slug, report path, delivery).

Done: delivery `confirmed`, its wait running, the step `implementing`, its `## Dispatches` line open.

## 4. When an agent comes back

1. Read its report (the path `dispatch` returned). Read the terminal (`herdr agent read <agent> --source recent-unwrapped --lines 80`) only when the report is missing or the agent is `blocked`; a `blocked` agent is asking for an approval or an answer: show the user what it asks.
2. `blocked` or open `questions`: answer from the plan when it settles them, otherwise ask the user; then dispatch the answer to the same agent (same role and slug).
3. **Developer `done`:** dispatch `role: "reviewer"` with the same `slug` right away (add `task` only to point at a risk). Mark the step `verified (relatório do dev)` and add the review as its own step.
4. **Reviewer back:** read `verdict`, `risk` and `findings`. Open the diff only at the lines a finding names, or wherever `risk: high`. Decide each finding (fix, defer with a reason, or reject with a reason). Send every fix back to the same developer as one brief, then review again. With `accept`, run the repository's done checks yourself in the worktree.
5. **Analyst or architect `done`:** call `finish` on that agent (`analyst`, `architect` or `analyst-<slug>`) once its report is read; use the findings in the next brief; hand `drafts` to the developer. Cut a design to the simplest version that meets the request and tell the user what you cut.

Close the `## Dispatches` line of every report you handle.

Done, by role:

- analyst or architect: report read, every question answered or asked to the user, findings carried into a step or a brief, the agent finished;
- reviewer: verdict read and every finding decided (a `changes_needed` review is done once its fixes are dispatched);
- developer task: the last review is `accept` and the done checks pass in your own run.
- your own steps (`main`, `git-master`): the step's action happened and you saw its result (a PR link, a merge state, a passing check).

## 5. Ship

1. **PR.** Codex's sandbox keeps `.git` read-only, so git work is yours through the `git-master:git-master` subagent: give it the worktree, the branch, the base, the paths to stage, the commit message and the PR title in Conventional Commits, the description you wrote, and the repository's PR rules. Tell the user the PR link.
2. **CI and merge.** Watch the checks. When the user has asked you to merge in this session, merge with `--match-head-commit <reviewed sha>` once CI passes; otherwise ask.
3. **After the merge.** Update the main checkout, reinstall the changed plugins (the repository's update task), and tell the user to run `/reload-plugins`: a reload is theirs to do.
4. **Close the task.** With the user's ok, call `finish` on each agent of the task (`dev-<slug>`, `architect-<slug>`, any `analyst-<slug>`); the tab closes with the last one and every session is archived. Then remove the worktree (`git worktree remove <path>`). A `finish` refusal names the agent still working: wait for it, never force it. Mark the PR step `committed`.

Done for a deliverable: merged, reinstalled, the user told to reload, its tab closed or kept by the user's choice, every step closed in the plan.
