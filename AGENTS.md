# AGENTS.md

Claude Code **function hooks mods** marketplace.

## Hooks and tools

- Hooks authoring or debugging: load the `plugin-authoring` skill first. The `claude-code` module is host-provided, not on npm.
- Registration: use one entry module (`register.tsx`) in `hooks.json`. Keep `on(...)` and `$.noun.method(...)` calls visible to the engine's source analysis: pass `$` only to a top-level function in the same file, never across an import. Subfolder registrars may own their hooks and `$` calls; pure modules take injected host access. Tests mirror modules.
- Tool matchers: `mcp__<plugin>__<name>` inputs in `types/index.d.ts` must match `inputSchema`.
- Typings: loading a plugin generates its git-ignored `.claude-plugin/types/`, which its `tsconfig.json` extends. The project SessionStart hook reuses complete snapshots from the main checkout only when they match the running Claude Code version; partial destinations are left untouched. If no compatible snapshot exists, run `mise run plugins:types`. Cached `claude-code-mcp` declarations reflect the main checkout's last connected tools, not runtime verification: regenerate after changing MCP integrations. `.claude/settings.json` wires the hooks in `.claude/hooks/`: `block-generated-types` denies Write/Edit of generated typings (hand-written `types/index.d.ts` stays editable) and `typecheck-plugin` type-checks the plugin owning an edited `.ts`/`.tsx`. Missing typings produce a reminder without blocking the edit. `scripts/check-consistency.mjs` fails when a hook script is not wired there; `scripts/*.test.mjs` cover the hooks and scripts (`mise run plugins:test`, CI).

## Where to look

- Plugin work: read `plugins/<name>/AGENTS.md`; `.claude/rules/<name>.md` imports it for that subtree. Keep plugin guidance there: a plugin-root `CLAUDE.md` draws a validation warning.
- ChatGPT browser tools: `plugins/chatgpt/AGENTS.md`.
- Native Mac app control through Codex: `plugins/codex-computer-use/AGENTS.md`.
- Specialist subagents, Jev routing and Codex twins: `plugins/crew/AGENTS.md`.
- Tailscale API tools: `plugins/tailscale/AGENTS.md`.
- Release checks: `/release-plugin <plugin>` → `.claude/skills/release-plugin/SKILL.md`.
- Real-session behavior: `/live-test <plugin>` → `.claude/skills/live-test/SKILL.md`.
- Approved merge: `/ship` → `.claude/skills/ship/SKILL.md`.
- Approved cleanup of merged branches/worktrees: `/cleanup` → `.claude/skills/cleanup/SKILL.md`.

## Commands

Find tasks and arguments with `mise tasks` and `mise tasks info <task>`; `mise.toml` owns versions and task commands. Install tools with `mise install`. For plugin-specific checks, read its AGENTS.md; for Claude CLI options, use `claude --help`.

## Conventions

- Write README, docs, code comments and plugin user-facing messages (labels, toasts, errors) in English.
- Bump `version` in `plugin.json` when plugin behavior changes.
- Done for a plugin change means: `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>` pass, `node scripts/check-consistency.mjs` passes, `version` is bumped if behavior changed, and the root README and the plugin's AGENTS.md match the new behavior.
- Use Conventional Commits in English for PR titles and English descriptions (`.github/pull_request_template.md`).
- Keep AGENTS.md to current invariants; put history in git and invariants explaining one line of code in a comment there.
