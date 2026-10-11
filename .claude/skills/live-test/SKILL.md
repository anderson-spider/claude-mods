---
name: live-test
description: Test a plugin of this repository live: open a Herdr pane on the right running `claude --plugin-dir plugins/<name>`, drive that session with prompts and audit what it did against the plugin's documented behavior. Use when asked to test, try or audit a plugin in a real session, or after a plugin change that tests alone cannot prove.
argument-hint: <plugin-name> [what to test]
---

# live-test

Runs the plugin named in `$ARGUMENTS` in a second Claude session beside this one and audits it from here. The test session is the subject; this session drives it and checks the evidence. It does not edit the plugin: findings go in the report, and fixing them is a separate step.

## 0. Preconditions

- `test "${HERDR_ENV:-}" = 1`, else say this session is not inside Herdr and stop.
- `plugins/<name>/.claude-plugin/plugin.json` exists, else list the plugins under `plugins/` and stop.
- Run `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>` first: a live test of a plugin that fails them proves nothing new.

## 1. The test session

Reuse before creating. `herdr pane list --workspace "$HERDR_WORKSPACE_ID"` and look for a pane in this worktree (`cwd`) whose agent is `claude`; check that its process runs this plugin with `ps -o args= -p <pid>` or `pgrep -fl -- '--plugin-dir plugins/<name>'`. A pane the user opened for the test counts: use it and say so.

Otherwise split to the right of this pane, keep focus here, and start Claude with the plugin:

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus     # .result.pane.pane_id
herdr agent start <name>-live --kind claude --pane <pane-id> -- --plugin-dir plugins/<name>
```

The session runs in the current worktree, which is already trusted through the main checkout. Never create a new git repository for a test: even under a trusted folder it prompts for trust.

`--plugin-dir` hot-reloads the folder, so a later edit reaches the test session without a restart; send `/reload-plugins` through `herdr agent prompt` when a hook must be re-registered at `session.start`. A scenario about reload or unload runs with no edits to `plugins/<name>` meanwhile, or the hot-reload muddies what it observes.

If the agent is `blocked` at start (a trust or hot-reload question), read it with `herdr agent read <target> --source visible` and ask the user; never answer a permission, trust or approval dialog for them.

Secrets and refusals:

- Never write a secret (to settings, argv or a `!` command, whose output lands in the transcript). When an option the test needs holds a secret, the user sets it from their own terminal.
- When a session start is refused, give the user a ready `! herdr …` command without any secret; when a settings write is refused, give the exact edit command (no secret) instead. Never try the refused action another way.
- Option changes for `--plugin-dir` go in `pluginConfigs["<name>@inline"].options` of `~/.claude/settings.json`, which is outside the worktree: write it only after the user's OK, with a backup beside it first. Restore it after the test, then delete the backup (it may hold a plain-text key).

## 2. Scenarios

Take what to check from, in order: the user's `$ARGUMENTS`, the `Live` line of `plugins/<name>/AGENTS.md` (its Checks section), then the behavior the current diff changes (`git diff origin/main -- plugins/<name>`). Write each scenario as one short prompt whose answer forces the behavior under test.

- A prompt the session can answer from context injected by other hooks (CodeGraph, memory) does not exercise a plugin's tool or delegation: ask for something that must run or change something, such as running a test suite or reading a file the context does not hold.
- Keep prompts small: every prompt spends the user's quota in the test session.
- Ask for nothing destructive, nothing outside this worktree, and no commit or push.

Send each one and wait for the session to settle:

```bash
herdr agent prompt <target> "<prompt>" --wait --timeout 600000
herdr agent read <target> --source recent-unwrapped --lines 150
```

A timeout or `agent_prompt_stalled` does not prove the prompt was lost: read the pane before sending anything again. A `blocked` state is a question for the user, not for this session to answer.

## 3. Evidence

What the pane shows is a claim; confirm it where the plugin leaves a record:

- the test session's transcript: `~/.claude/projects/<dashed cwd>/<session id>.jsonl`, its subagents under `<session id>/subagents/agent-<id>.jsonl` (each assistant row carries `message.model` and `effort`); the session id is the pane's `agent_session.value` in `herdr pane list`;
- the plugin's own records, as its AGENTS.md describes them (for crew, `~/.claude/crew/decisions/*.json`, newest last by name);
- for hooks that log only to debug, start the session with `-- --plugin-dir plugins/<name> --debug-file <scratchpad>/<name>.log` and read that file.

Run `git check-ignore -q .crew` before a report is written there; if it fails, write nowhere in the repository.

Compare each observation with the documented behavior in the root README and the plugin's AGENTS.md. A difference is a finding even when the plugin "works".

## 4. After

Close the test pane once the evidence is read, also when a scenario failed: `herdr pane close <pane-id>`. That covers a pane this skill created and one the user opened for the test; leave any other pane alone. Read everything the report needs before closing, since the pane's scrollback goes with it (the transcripts and the plugin's records stay on disk).

## Report

Three sections, in this order, with the headings and language of the user's global instructions:

- **Blocked on the user**: dialogs that need their answer, a merge or a decision.
- **Changed**: what this session did in the test session (pane created or reused, prompts sent); no code edits.
- **Found**: each scenario with its result and the evidence (`path:line`, a transcript or record field, the pane lines), and each mismatch with the docs, most severe first. No test counts.
