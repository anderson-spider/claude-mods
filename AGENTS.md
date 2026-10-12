# AGENTS.md

Claude Code **function hooks mods** marketplace. Hooks authoring or debugging: load the `plugin-authoring` skill first. The `claude-code` module is host-provided, not on npm; loading a plugin generates its git-ignored `.claude-plugin/types/`, which its `tsconfig.json` extends.

## Layout

- Hooks: one entry module (`register.tsx`) in `hooks.json`. Keep `on(...)` and `$.noun.method(...)` calls visible to the engine's source analysis: pass `$` only to a top-level function in the same file, never across an import. Subfolder registrars may own their hooks and `$` calls; pure modules take injected host access. Tests mirror modules.
- Tools: `mcp__<plugin>__<name>` inputs in `types/index.d.ts` must match `inputSchema` for the matchers.
- Workflow skills: `/release-plugin <plugin>` checks completion; `/live-test <plugin>` verifies real-session behavior; `/ship` ships through an approved merge; `/cleanup` removes merged branches/worktrees after approval. Read the corresponding `.claude/skills/<name>/SKILL.md` when invoked.
- `.claude/hooks/` protects generated `.claude-plugin/types/` (hand-written `types/index.d.ts` stays editable) and type-checks the plugin owning an edited `.ts`/`.tsx`. Missing typings produce a `mise run plugins:types` reminder without blocking the edit.

## Plugins

Plugin work: read `plugins/<name>/AGENTS.md`; `.claude/rules/<name>.md` imports it for that subtree. Keep plugin guidance there: a plugin-root `CLAUDE.md` draws a validation warning.

- **chatgpt**: ChatGPT browser tools; see `plugins/chatgpt/AGENTS.md`.
- **codex-computer-use**: native Mac app control through Codex; see `plugins/codex-computer-use/AGENTS.md`.
- **codex-models**: native Codex models through a local Go proxy; see `plugins/codex-models/AGENTS.md`.
- **crew**: specialist subagents with Jev routing and Codex twins; see `plugins/crew/AGENTS.md`.
- **tailscale**: Tailscale API tools; see `plugins/tailscale/AGENTS.md`.

## Commands

Discover repository tasks with `mise tasks` and their arguments with `mise tasks info <task>`; `mise.toml` owns tool versions and task commands. Install tools with `mise install`. For plugin-specific checks, read that plugin's AGENTS.md; for Claude CLI options, use `claude --help`.

## Conventions

- README, docs, code comments and user-facing messages in the plugins (labels, toasts, errors) are in English.
- When a plugin's behavior changes, bump `version` in its `plugin.json`.
- Done for a plugin change means: `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>` pass, `node scripts/check-consistency.mjs` passes, `version` is bumped if behavior changed, and the root README and the plugin's AGENTS.md match the new behavior.
- PR titles follow Conventional Commits in English and descriptions are in English (`.github/pull_request_template.md`).
- AGENTS.md holds current invariants; history belongs in git. Invariants explaining one line of code belong in a comment there.
