---
name: release-plugin
description: Run the done checklist for a plugin change (validate, test, consistency, version bump, docs) and report what is missing
disable-model-invocation: true
argument-hint: <plugin-name> [<plugin-name>...]
---

# release-plugin

Checks that a change to the plugin(s) named in `$ARGUMENTS` meets the "done" definition in `AGENTS.md`. It never edits files or commits; it lists what to fix.

With no argument, derive the plugins from `git diff --name-only origin/main` (paths under `plugins/<name>/`). Run the steps once per plugin; `<name>` below is each one.

## Steps

Run in order and keep going after a failure so the report is complete.

0. **Base**: `git fetch origin main`, then note whether `git status --porcelain -- plugins/<name>` is empty. Steps 4 and 5 compare against `origin/main`; `scripts/check-version-bump.mjs` compares `HEAD`, so it ignores uncommitted changes. If the tree is dirty, say so in the report and judge steps 4 and 5 from `git diff origin/main -- plugins/<name>` (working tree included).
1. **Validate**: `claude plugin validate plugins/<name>`
2. **Tests**: `claude plugin test plugins/<name>`. For `codex-computer-use`, also run the helper with `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test plugins/codex-computer-use/helper/test/*.test.mjs`; if that node is missing, report the helper as skipped. For a plugin with a `proxy/` directory, also run `go -C plugins/<name>/proxy vet ./...`, `go -C plugins/<name>/proxy test -race ./...` and `node --test plugins/<name>/tests/scripts/*.test.mjs`.
3. **Consistency**: `node scripts/check-consistency.mjs`
4. **Version bump**: `node scripts/check-version-bump.mjs origin/main`. If it flags the plugin, or the tree is dirty, compare `version` in `plugins/<name>/.claude-plugin/plugin.json` against `git show origin/main:plugins/<name>/.claude-plugin/plugin.json`.
5. **Docs match behavior**: read `git diff origin/main -- plugins/<name>` and check that the plugin's section in the root `README.md` and the plugin's `AGENTS.md` describe the new behavior (tools, options, messages, commands). `AGENTS.md` holds current invariants only; history belongs in git.
6. **Tool inputs**: if a tool's `inputSchema` changed, `types/index.d.ts` must match it.

## Report

Three sections, in this order: what is blocked on the user, what changed, what was found (the user's global instructions set the exact headings and language).

- **Blocked on the user**: what only they can do, such as choosing the bump level when behavior is ambiguous.
- **Changed**: always nothing, since the skill does not edit; list each step's result (pass, fail or skipped) without test counts.
- **Found**: each failure or gap with `path:line` and the exact command output that shows it.

Suggest the bump level (major for breaking, minor for a new feature, patch for a fix) but do not apply it.
