---
name: live-test
description: Live-test plugin behavior in a real session when requested, or when automated tests cannot prove a plugin change.
argument-hint: <plugin-name> [what to test]
---

# live-test

Drive the plugin in `$ARGUMENTS` in a second Claude session beside this one; audit evidence here. Keep plugin code unchanged and report findings for a separate fix.

## 0. Preconditions

Require `HERDR_ENV=1` and `plugins/<name>/.claude-plugin/plugin.json`; otherwise report the missing condition (list available plugins for an unknown name) and stop. Proceed only after `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>` pass.

## 1. Session

Reuse a test pane before creating one: `herdr pane list --workspace "$HERDR_WORKSPACE_ID"`; match this worktree's cwd and a Claude process whose argv names this plugin (`ps -o args= -p <pid>`). A pane the user opened for this test qualifies; identify it in the report.

Otherwise use `herdr pane split` to the right, in this worktree, without taking focus, then `herdr agent start` with `--plugin-dir plugins/<name>`. Consult each command's `--help` for arguments. Use the trusted worktree rather than a new test repository, which would prompt for trust.

Reload/unload scenarios require unchanged plugin files: `--plugin-dir` hot-reloads edits and would confound the evidence. Use `/reload-plugins` to reload hooks; a `session.start` scenario requires a new session, not a reload.

**Approval**: read a blocked pane with `herdr agent read <target> --source visible` and ask the user. Never answer their permission, trust or approval dialogs. On a refused start, give a ready secret-free `! herdr …` command; on a refused settings write, give the exact secret-free edit command. Leave the refused action to the user rather than retrying another route.

**Secrets**: the user sets secret options from their own terminal; never write secrets into settings, argv or transcript-producing `!` commands. For other inline option changes, use `pluginConfigs["<name>@inline"].options` in `~/.claude/settings.json` only after the user's OK, with a backup beside it first. Restore after testing, then delete this test backup, which may contain a plain-text key.

Proceed when a running test session has a known pane/target and the intended plugin/options.

## 2. Scenarios

Choose scenarios from the user's arguments, then the plugin AGENTS.md's live checks, then behavior changed by `git diff origin/main -- plugins/<name>`. Give each a short prompt that forces the tested behavior; injected context alone cannot prove a tool call or delegation. Keep the scope non-destructive and inside this worktree, with no commit or push.

Send with `herdr agent prompt <target> "<prompt>" --wait --timeout 600000`, then read `herdr agent read <target> --source recent-unwrapped --lines 150`. After a timeout or `agent_prompt_stalled`, read before resending: the prompt may already have arrived. A blocked state requires the user's answer.

Finish when every scenario has an observed outcome or an identified blocker.

## 3. Evidence

Treat pane claims as hypotheses; confirm each against the records:

- Transcript: `~/.claude/projects/<dashed cwd>/<session id>.jsonl`; subagents: `<session id>/subagents/agent-<id>.jsonl`. Read session id from the pane's `agent_session.value`; assistant rows carry `message.model` and `effort`.
- Plugin records: consult its AGENTS.md for locations and fields.
- Debug-only hooks: start with `--debug-file <scratchpad>/<name>.log` and read it.

Compare every scenario with the root README and plugin AGENTS.md, recording mismatches even when the plugin works. Before writing a report under `.crew/`, require `git check-ignore -q .crew`; otherwise write no report in the repository. Capture all supporting paths/fields or pane lines before closing.

## 4. Close and report

Close the test pane with `herdr pane close <pane-id>` after collecting evidence, including on scenario failure; this includes a pane the user opened for the test. Leave other panes alone. Restore approved settings changes and confirm cleanup or report its blocker.

Use the user's headings and language, ordered blocked on the user, changed, found. Include dialogs/decisions, the pane created/reused and prompts sent (no code edits), then each scenario's outcome, evidence and doc mismatches, most severe first. Describe only validation actually performed, without test counts.
