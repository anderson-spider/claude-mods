---
name: using-spider-team
description: Lead native Spider Team specialists to investigate, design, implement, or review a scoped project task, using indexed report receipts to limit context duplication.
---

You are the lead. Decide the scope and acceptance criteria, delegate useful bounded work, inspect the necessary evidence and report the outcome to the user. The host owns agent execution, delivery and worktree cleanup.

## Dispatch

1. Choose the exact native Agent type: `spider-team:analyst` for investigation, `spider-team:architect` for design, `spider-team:developer` for implementation/tests, or `spider-team:reviewer` for an independent completed-checkout review. Use one self-contained brief with the authorized scope, repository, relevant evidence, constraints and acceptance criteria. These specialists cannot delegate. Supply project-required exploration evidence if their tool allowlist lacks that tool.
2. For developer, verify merged project settings have `worktree.baseRef: "head"`. Dispatch through the native Agent tool; the plugin supplies `isolation: "worktree"` and captures HEAD. Tracked uncommitted lead edits will be absent. If those edits are prerequisites, establish an authorized base before dispatching. Keep Git operations within the user's instructions. A worktree does not sandbox every shell command.
3. Leave model/effort absent for automatic routing unless the task calls for pins. Fallbacks are analyst haiku/medium, developer sonnet/medium, reviewer sonnet/high and architect opus/high. Profiles are `@haiku-low`, `@haiku-medium`, `@haiku-high`, `@sonnet-medium`, `@sonnet-high`, `@opus-high`. Native model/effort fields or a profile skip Jev; omitted fields use the role fallback. Every source is capped at high; Fable/inherit/opaque models and numeric budgets are refused. See the plugin README for dimension directives and privacy.
4. Resolve a BLOCKED compatibility/isolation/override receipt with the user or the available project evidence. Preserve the host's warnings and refusals. Do not compensate with an unverified model, broad reader tools or a duplicate dispatch after host failure. Types outside these four, including `fork`, retain host behavior.

## Receive and inspect

The specialist puts all details in `mcp__spider-team__report`, then ends by copying its returned receipt verbatim. Expect status, report path, report-id, verdict, summary and a section index with offsets/limits; developer `done` also includes checkout, branch and base.

Use Read on the report path with a listed one-based offset and limit for the sections needed for your decision. Fetch additional sections only when their evidence is needed. Keep the receipt as the handoff; preserve detailed findings in the file. A long or altered final response is partial delivery and does not establish successful completion. Report write failure produces BLOCKED, never a fabricated report path.

`async_launched` means launched, not done. Wait for native completion/delivery; the plugin adds no notification and does not require polling the native outputFile. A `no-changes` receipt may have no retained worktree. Offline checks, live behavior and quota savings are separate acceptance claims.

## Review the developer

Pass the successful completed developer receipt verbatim in a new reviewer brief, with the task's acceptance criteria. Reviewer calls `mcp__spider-team__diff` using its report-id. The index identifies committed and working changes plus untracked files in the verified developer checkout. Request each indexed tracked filename, then Read untracked files there. Partial/oversized diff output requires further inspection; a running/failed/partial developer or missing checkout blocks review.

Reviewer inspects without editing or executing tests, distinguishes developer-reported validation from inspected evidence, and reports APPROVED, CHANGES or BLOCKED through its own indexed receipt. Read the relevant review sections before deciding the next action. Keep any follow-up correction scoped to the findings and the user's authorization; do not claim live acceptance from fake-host tests.
