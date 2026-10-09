# Pantheon skills: a lean workflow that replaces superpowers

## Goal

Give the Pantheon plugin its own small set of skills so the orchestrator no longer depends on the `superpowers` plugin, which can then be uninstalled. The set must cost fewer tokens than superpowers: one plan instead of spec plus plan, briefs built from the plan's task section, and independent review only where it pays.

Evidence from the profiles PR (#99): the plan copied spec values, briefs copied the plan, the oracle reviewed the spec, every task and the branch, and the generic implementer template sat on top of the Codex role prompt.

## Scope

In:
- Four skills in `plugins/pantheon/skills/`: `grill`, `execute`, `debug`, `finish`.
- Remove the "Superpowers Integration" block (`hooks/prompts/superpowers.ts` and its use in `orchestrator.ts`), and update `README.md`, `AGENTS.md` and `docs/` to match.
- Bump the `pantheon` plugin version.

Out: TDD as its own skill (it becomes a rule in `execute`), `using-git-worktrees` (a step in `grill`), `writing-skills`, and any equivalent of `using-superpowers` (the orchestrator prompt already routes work).

The orchestrator invokes the skills itself from their descriptions, as it does with superpowers today. There are no slash commands for them.

## Skills

### `grill`

Brainstorm that ends in a plan. Replaces brainstorming and writing-plans.

1. Ask one question at a time, each with a recommendation, until the understanding is shared. Write the understanding back before planning.
2. Read before asking: dispatch `explorer` for code and `librarian` for docs, in parallel when both are needed.
3. Create the worktree with `EnterWorktree` and a `name` derived from the topic. The tool creates the branch; nothing creates a branch separately. If the session is already in a worktree, stay in it. With the default `worktree.baseRef` (`fresh`) the worktree starts from `origin/<default branch>`; say so when the work depends on unpushed commits.
4. Write the plan to `.pantheon/plans/YYYY-MM-DD-<topic>.md` and add `.pantheon/` to `.git/info/exclude` (shared by all worktrees; no tracked file changes). The plan is never committed.

Plan format: a short context and decisions section, then tasks. Each task has: goal, files, interfaces, acceptance criteria, `risk: yes|no`, `parallel: yes|no`. Tasks carry no code and do not copy other sections.

### `execute`

Runs the plan. Replaces subagent-driven-development, executing-plans, dispatching-parallel-agents and the per-task review gates.

- Brief for the implementer: only the task section plus the interfaces it names. `fixer` and `designer` run through `delegate` (Codex) or the native `pantheon:<role>` agent, per the active profile.
- Order: sequential by default. Tasks run together only when the plan marks `parallel: yes` and their files are disjoint. Read-only lanes (`explorer`, `librarian`) always run in parallel.
- Every brief requires writing the test first (the former `tdd` skill). The implementer does not commit; the orchestrator commits each task.
- Failure handling: retry the same implementer once with the error, then ask `oracle` to diagnose, then ask the person.
- Review: `oracle` reviews a task only when it is marked `risk: yes`. Each gate has one review and at most two re-reviews, and a re-review happens only when the fix changed the reviewed decision or risk. Before a gate the orchestrator records what changed, the validation evidence and the specific risk, so the oracle does not rediscover context.

### `debug`

Systematic debugging: reproduce, form hypotheses, confirm the cause with evidence, then fix. Dispatch `explorer` for unfamiliar code and `oracle` when the cause is unclear after a first pass. No fix before a confirmed cause.

### `finish`

Verification and closing. Replaces verification-before-completion, requesting/receiving-code-review and finishing-a-development-branch.

- Run the real validation commands and read their output before claiming anything passes.
- One `oracle` review over the whole branch (one review, at most two re-reviews).
- Open the PR, and remove the worktree only when the person asks.

## Orchestrator prompt

`orchestrator.ts` drops the superpowers section. It gains a short routing note: use `grill` before creative or multi-step work, `execute` to carry out a plan, `debug` on a bug or failing test, and `finish` before claiming completion. Role definitions, Council Mode and profile handling do not change.

## Testing

- A test checks that every `skills/*/SKILL.md` exists with valid frontmatter (`name`, `description`) and that `name` matches the directory.
- A test checks that the orchestrator prompt no longer mentions superpowers and names the four skills.
- `claude plugin validate plugins/pantheon`, `claude plugin test plugins/pantheon` and `node scripts/check-consistency.mjs` pass; the version is bumped.

## Open points

- The skills are text; whether the orchestrator invokes them at the right moments can only be judged by using them. Plan a trial on a real task after the change lands.
- `docs/design.md` and `docs/plan.md` inside the plugin mention superpowers; update or remove them with the prompt change.
