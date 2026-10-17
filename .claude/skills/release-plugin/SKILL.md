---
name: release-plugin
description: Check plugin completion against validation, tests, version and docs.
disable-model-invocation: true
argument-hint: <plugin-name> [<plugin-name>...]
---

# release-plugin

Check the plugins in `$ARGUMENTS` against the done definition in root `AGENTS.md`; leave files and commits unchanged. With no arguments, derive plugins from `git diff --name-only origin/main` and `git ls-files --others --exclude-standard` (paths under `plugins/<name>/`). Continue after failures until every check has a result for each plugin.

## Steps

0. **Base**: fetch `origin main`; record dirty/untracked paths under each plugin. Review the working-tree diff against `origin/main` plus untracked files. Finish with every changed and untracked plugin path accounted for.
1. **Checks**: run `npm run check -- <name>` for each plugin: the version bump, `validate --strict`, consistency, tests and type-check, with the pinned CLI. Record each `=== <step>` section's result and the closing `check passed`/`check failed` line. Also run any automated check the plugin's AGENTS.md names beyond these; live scenarios belong to `/live-test`.
2. **Version**: the bump step compares `HEAD` with `origin/main`, so it misses uncommitted changes. For a flagged or dirty plugin, compare its manifest version with `git show origin/main:plugins/<name>/.claude-plugin/plugin.json`; finish with the root version rule assessed for every such plugin.
3. **Docs**: compare every behavior change in the diff/untracked files with the root README's plugin section and that plugin's AGENTS.md; finish with each change matched to docs or a named mismatch.
4. **Inputs**: for every changed tool `inputSchema`, verify matching `types/index.d.ts`; finish with each match recorded, or mark this step not applicable.

## Report

Use the user's headings and language, in order: blocked on the user, changed, found. State that no files changed; give each step's pass/fail/skipped result without test counts, and each gap with `path:line` and supporting command output. Suggest, but leave unapplied, a bump level: major for breaking, minor for a feature, patch for a fix.
