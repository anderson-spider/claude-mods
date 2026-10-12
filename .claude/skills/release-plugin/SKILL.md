---
name: release-plugin
description: Check plugin completion against validation, tests, version and docs.
disable-model-invocation: true
argument-hint: <plugin-name> [<plugin-name>...]
---

# release-plugin

Check the plugins in `$ARGUMENTS` against the done definition in root `AGENTS.md`; leave files and commits unchanged. With no arguments, derive plugins from `git diff --name-only origin/main` and `git ls-files --others --exclude-standard` (paths under `plugins/<name>/`). Continue after failures until every check has a result for each plugin.

## Steps

0. **Base**: fetch `origin main`; record dirty/untracked paths under each plugin. Review the working-tree diff against `origin/main` plus untracked files. The version script compares `HEAD`, so compare dirty versions manually in step 4. Finish with every changed and untracked plugin path accounted for.
1. **Validate**: run `claude plugin validate plugins/<name>`; record its result.
2. **Tests**: run `claude plugin test plugins/<name>` and the plugin-specific automated checks in its AGENTS.md (Tests/Checks: helper and type-check commands). Record every result or skipped prerequisite; live scenarios belong to `/live-test`.
3. **Consistency**: run `node scripts/check-consistency.mjs`; record its result.
4. **Version**: run `node scripts/check-version-bump.mjs origin/main`. For a flagged or dirty plugin, compare its manifest version with `git show origin/main:plugins/<name>/.claude-plugin/plugin.json`; finish with the root version rule assessed for every such plugin.
5. **Docs**: compare every behavior change in the diff/untracked files with the root README's plugin section and that plugin's AGENTS.md; finish with each change matched to docs or a named mismatch.
6. **Inputs**: for every changed tool `inputSchema`, verify matching `types/index.d.ts`; finish with each match recorded, or mark this step not applicable.

## Report

Use the user's headings and language, in order: blocked on the user, changed, found. State that no files changed; give each step's pass/fail/skipped result without test counts, and each gap with `path:line` and supporting command output. Suggest, but leave unapplied, a bump level: major for breaking, minor for a feature, patch for a fix.
