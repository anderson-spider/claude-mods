# AGENTS.md

Claude Code **function hooks mods** marketplace.

## Hooks and tools

- Hooks authoring or debugging: load the `plugin-authoring` skill first. The `claude-code` module is host-provided, not on npm.
- Registration: use one entry module (`register.tsx`) in `hooks.json`. Keep `on(...)` and `$.noun.method(...)` calls visible to the engine's source analysis: pass `$` only to a top-level function in the same file, never across an import. Subfolder registrars may own their hooks and `$` calls; pure modules take injected host access. Tests mirror modules.
- Worktrees: `.claude/settings.json` sets `worktree.baseRef: "head"`, so subagent, `--worktree` and `EnterWorktree` worktrees start from the session's HEAD (the `andersonsilva/*` branch), not `origin/main`; the `spider-team` developer refuses to run without it.
- Tool matchers: `mcp__<plugin>__<name>` inputs in `types/index.d.ts` must match `inputSchema`.
- Typings: loading a plugin generates its git-ignored `.claude-plugin/types/`, which its `tsconfig.json` extends; the plugin's own `noEmit` (checked by `check-consistency`) keeps `tsc` from writing a `.js` beside each `.ts` when they are missing. The project SessionStart hook reuses complete snapshots from the main checkout only when they match the running Claude Code version; partial destinations are left untouched. If no compatible snapshot exists, run `mise run plugins:types` for every plugin or `mise run plugins:types <name>` for one. Cached `claude-code-mcp` declarations reflect the main checkout's last connected tools, not runtime verification: regenerate after changing MCP integrations. `.claude/settings.json` wires the hooks in `.claude/hooks/`: `block-generated-types` denies Write/Edit of generated typings (hand-written `types/index.d.ts` stays editable) and `typecheck-plugin` type-checks the plugin owning an edited `.ts`/`.tsx`. Missing typings produce a reminder without blocking the edit. A hook script declares its event and matcher on its first line (`// PreToolUse (Edit|Write): why`), and `scripts/check-consistency.mjs` fails unless `.claude/settings.json` wires it there with its own `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<file>"` command. `scripts/*.test.mjs` test the two hooks, `ensure-plugin-types`, `check-consistency`, `check-version-bump` and `new-plugin`; `update-plugins` has no test (`mise run plugins:test`, CI).

## Where to look

- Plugin work: read `plugins/<name>/AGENTS.md`; `.claude/rules/<name>.md` imports it for that subtree. Keep plugin guidance there: a plugin-root `CLAUDE.md` draws a validation warning.
- ChatGPT browser tools: `plugins/chatgpt/AGENTS.md`.
- Native Mac app control through Codex: `plugins/codex-computer-use/AGENTS.md`.
- Codex team in Herdr, led by the session (developer, analyst, architect): `plugins/codex-team/AGENTS.md`.
- Git subagent on Haiku (git-master): `plugins/git-master/AGENTS.md`.
- GitLab merge requests and pipelines of the current repository, host and token from its remote: `plugins/gitlab/AGENTS.md`.
- Session card above the prompt (model, context, limits, the turn, edits and errors): `plugins/session-hud/AGENTS.md`.
- Native Spider Team specialists: `plugins/spider-team/AGENTS.md`.
- Tailscale API tools: `plugins/tailscale/AGENTS.md`.
- Release checks: `/release-plugin <plugin>` → `.claude/skills/release-plugin/SKILL.md`.
- Real-session behavior: `/live-test <plugin>` → `.claude/skills/live-test/SKILL.md`.
- Approved merge: `/ship` → `.claude/skills/ship/SKILL.md`.
- Approved cleanup of merged branches/worktrees: `/cleanup` → `.claude/skills/cleanup/SKILL.md`.

## Commands

Find tasks and arguments with `mise tasks` and `mise tasks info <task>`; `mise.toml` owns versions and task commands. Install tools with `mise install`. For plugin-specific checks, read its AGENTS.md; for Claude CLI options, use `claude --help`.

## Conventions

- Write README, docs, code comments and plugin user-facing messages (labels, toasts, errors) in English.
- Bump `version` in `plugin.json` when any file a plugin ships changes: every file under `plugins/<name>/` except `tests/`, `helper/test/`, `docs/`, `*.test.*` files and the root `*.md` files (README.md, AGENTS.md). Hooks, helper, skills (`SKILL.md` included), `types/`, `tsconfig.json` and the manifest count. `node scripts/check-version-bump.mjs <base-ref>` enforces it on pull requests.
- CI (`.github/workflows/ci.yml`) runs the consistency and bump checks, the script and helper tests, and, for every plugin listed in `marketplace.json`, `claude plugin validate --strict` and `claude plugin test` with the Claude Code CLI installed from npm at the version `CLAUDE_CLI_PIN` sets in that file, which must equal the version README.md says the repository is checked with (no login, no generated typings).
- CI also scaffolds `ci-sample` in a copy of the checkout and runs its `validate --strict` and `test`; the scaffold's `tsc` is not run in CI (no typings there) and is proven by running `mise run plugin:new` locally.
- Done for a plugin change means: `claude plugin validate --strict plugins/<name>` and `claude plugin test plugins/<name>` pass, `node scripts/check-consistency.mjs` passes, `version` is bumped if shipped files changed, and the root README and the plugin's AGENTS.md match the new behavior.
- Adding a plugin: `mise run plugin:new <name> [description]` writes every piece listed next from `scripts/plugin-template/`, then generates the typings. The name is lowercase words joined by hyphens (26 characters at most, so `mcp__<name>__<tool>` stays within 64); an existing or invalid one is refused before any file is written. The plugin comes with a sample tool whose `inputSchema` is held to `types/index.d.ts` by `SchemaFor` (`hooks/schema.ts`), pure logic with its test, and the host fake `tests/host.ts`; replace the sample, fill the texts and run the done checks. A change to the template keeps `scripts/new-plugin.test.mjs` passing: a scaffolded plugin has no `check-consistency` problem.
- Adding or removing a plugin: `node scripts/check-consistency.mjs` is the checklist. It prints one line per missing piece (manifest and marketplace entry with the same description, `tsconfig.json`, `AGENTS.md`, `README.md`, `.claude/rules/<name>.md` importing the plugin's AGENTS.md with `plugins/<name>/**` in its `paths`, the backticked `plugins/<name>/AGENTS.md` under "Where to look" here, the root README table row and install line) and fails on orphans: a plugin directory or rule file with no marketplace entry (a rule that is not a plugin's goes in a subdirectory of `.claude/rules/`). Cite a test in a plugin `AGENTS.md` as `` `tests/<file>.test.ts` (`name`, `name`) `` or `` `tests/<file>.test.ts`: `name` `` (`helper/test/<file>.test.mjs` works the same), verbatim; the check fails on a cited file that does not exist and on a name its file does not declare. A backticked support file under `tests/` or `helper/test/` that is not a test file (`tests/host.ts`, `helper/test/contract.mjs`) must exist, and nothing else about it is checked. A citation in any other shape is not checked.
- Refactor PRs diff `mise run plugins:scan` (the saved `claude plugin validate --strict` output, git-ignored) before and after.
- Use Conventional Commits in English for PR titles and English descriptions (`.github/pull_request_template.md`).
- Keep AGENTS.md to current invariants; put history in git and invariants explaining one line of code in a comment there.
