---
name: release-plugin
description: Check plugin completion and report gaps in validation, tests, version and docs.
disable-model-invocation: true
argument-hint: <plugin-name> [<plugin-name>...]
---

# release-plugin

Check the plugins in `$ARGUMENTS` against the done definition in root `AGENTS.md`; leave files and commits unchanged. With no arguments, derive plugins from `git diff --name-only origin/main` and `git ls-files --others --exclude-standard` (paths under `plugins/<name>/`). Run every step per plugin, continuing after failures for a complete report.

## Steps

0. **Base**: fetch `origin main`; record dirty/untracked paths under each plugin. Review the working-tree diff against `origin/main` plus untracked files. The version script compares `HEAD`, so dirty changes need the manual comparison in step 4.
1. **Validate**: run `claude plugin validate plugins/<name>`; record its result.
2. **Tests**: run `claude plugin test plugins/<name>` and the plugin-specific automated checks in its AGENTS.md (Tests/Checks: helper, proxy including contracts, installer and type-check commands). For a proxy also run `go -C plugins/<name>/proxy vet ./...`. Record every result or skipped prerequisite; live scenarios belong to `/live-test`.
3. **Consistency**: run `node scripts/check-consistency.mjs`; record its result.
4. **Version**: run `node scripts/check-version-bump.mjs origin/main`. For a flagged or dirty plugin, compare its manifest version with `git show origin/main:plugins/<name>/.claude-plugin/plugin.json`; report whether the current change satisfies the root version rule.
5. **Docs**: compare every behavior change in the diff/untracked files with the root README's plugin section and that plugin's AGENTS.md; identify each mismatch under the root conventions.
6. **Inputs**: for every changed tool `inputSchema`, verify matching `types/index.d.ts`; record mismatches or mark this step not applicable.

## Report

Use the user's headings and language, in order: blocked on the user, changed, found. State that no files changed; give each step's pass/fail/skipped result without test counts, and each gap with `path:line` and supporting command output. Suggest, but leave unapplied, a bump level: major for breaking, minor for a feature, patch for a fix.
