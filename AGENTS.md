# AGENTS.md

Claude Code **function hooks mods** marketplace. User-facing setup is in [README.md](README.md); this file holds the rules for changing the code.

## Where to look

- Plugin work: read `plugins/<name>/AGENTS.md`; `.claude/rules/<name>.md` tells a session to read it once a file in that subtree is touched (a pointer, not an `@` import: Claude Code resolves imports in a `paths` rule at session start). Keep plugin guidance there: a plugin-root `CLAUDE.md` draws a validation warning.
- ChatGPT browser tools: `plugins/chatgpt/AGENTS.md`.
- Native Mac app control through Codex: `plugins/codex-computer-use/AGENTS.md`.
- Coolify API tools (projects, applications, deployments): `plugins/coolify/AGENTS.md`.
- GitLab merge requests and pipelines of the current repository: `plugins/gitlab/AGENTS.md`.
- Session card above the prompt: `plugins/session-hud/AGENTS.md`.
- Read-only analyst, planner and reviewer subagents with Jev routing (spider-team): `plugins/spider-team/AGENTS.md`.
- Tailscale API tools: `plugins/tailscale/AGENTS.md`.
- Hooks authoring or debugging: load the `plugin-authoring` skill first. The `claude-code` module is host-provided, not on npm.

Project skills (`.claude/skills/`):

| Skill | Use |
| --- | --- |
| `/release-plugin <plugin>` | Check a plugin against the done definition below; changes nothing. |
| `/live-test <plugin>` | Drive the plugin in a second session (needs herdr) when unit tests cannot prove the change. |
| `/ship` | Checks, review, PR, approved merge and plugin update for the current branch. |

## Commands

Node 24 (`.nvmrc`; any version manager that reads it works), then `npm ci` once. `package.json` and its lockfile own the tool versions (the Claude Code CLI and TypeScript, exact) and name the tasks; `npm run` lists them and runs them with `node_modules/.bin` first on PATH. Task bodies live in `scripts/tasks/`; pass arguments after `--` (`npm run plugins:types -- gitlab`). The checks (`check`, `plugins:validate`, `plugins:test`, `plugins:scan`) run the pinned CLI, as CI does: from this checkout's `node_modules`, else the main checkout's (a fresh worktree has none), and they stop when neither has it. `plugins:types`, `plugins:update` and `update:all` run your own `claude` instead, so the typings carry the version your sessions match and installed plugins are updated by the CLI that owns them (`scripts/tasks/lib.sh`). `npm run typecheck [-- <name>]` runs the pinned `tsc` on one plugin or all of them. `plugins:validate`, `plugins:test` and `typecheck` take an optional plugin name, run every target even after a failure, and fail at the end naming what failed; `npm run check [-- <name>]` runs the version bump check against `origin/main` as last fetched, then those three, the same way. `npm run install:test` (needs Docker) installs the marketplace from the checkout on a clean Linux image the way a new user does, through `scripts/bootstrap.sh`, and checks that each plugin is listed at its source version, passes its tests from the installed copy and loads in a session without login (`scripts/install-test/`). Plugin-specific checks are in each plugin's AGENTS.md.

## Code rules

- Registration: one entry module (`register.tsx`) in `hooks.json`. Keep `on(...)` and `$.noun.method(...)` calls visible to the engine's source analysis: pass `$` only to a top-level function in the same file, never across an import. Subfolder registrars may own their hooks and `$` calls; pure modules take injected host access. Tests mirror modules.
- Tool inputs: each `mcp__<plugin>__<name>` entry in `types/index.d.ts` must match its `inputSchema` (`SchemaFor`, `hooks/schema.ts`, identical in every plugin and in `scripts/plugin-template/`).
- Typings: loading a plugin writes its git-ignored `.claude-plugin/types/`, which its `tsconfig.json` extends (`noEmit` is required). The SessionStart hook copies complete snapshots from the main checkout when they match the running Claude Code version; otherwise run `npm run plugins:types [-- <name>]`. Regenerate after changing MCP integrations: cached `claude-code-mcp` declarations reflect the main checkout's last connected tools.
- Project hooks (`.claude/settings.json` → `.claude/hooks/`): `block-generated-types` denies Write/Edit of generated typings (hand-written `types/index.d.ts` stays editable); `typecheck-plugin` type-checks the plugin owning an edited `.ts`/`.tsx` with the pinned `tsc` (this checkout's, else the main checkout's); `cloud-setup` (SessionStart, Claude Code cloud sessions only) runs `npm ci` unless the installed tree already matches, and puts `node_modules/.bin` last on the session's PATH, so `tsc` is the pinned one and `claude` the session's own. A hook script declares its event and matcher on its first line (`// PreToolUse (Edit|Write): why`), and `check-consistency` fails unless the settings wire it with `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<file>"`.
- Scripts in `scripts/` have a `*.test.mjs` beside them; the task shells in `scripts/tasks/` are thin wrappers over them and the `claude` CLI, without tests of their own.

## Done for a plugin change

1. `claude plugin validate --strict plugins/<name>` passes, and `claude plugin test plugins/<name>` passes unless the plugin ships only skills.
2. `node scripts/check-consistency.mjs` passes.
3. `version` in `plugin.json` is bumped if a shipped file changed: anything under `plugins/<name>/` except `tests/`, `helper/test/`, `docs/`, `*.test.*` and the root `*.md` files. `node scripts/check-version-bump.mjs <base-ref>` enforces it.
4. The root README and the plugin's AGENTS.md match the new behavior.

## Adding or removing a plugin

- `npm run plugin:new -- <name> [description]` scaffolds from `scripts/plugin-template/` and generates the typings. Names are lowercase words joined by hyphens, 26 characters at most (so `mcp__<name>__<tool>` fits in 64). The scaffold has a sample tool, pure logic with its test and the host fake `tests/host.ts`: replace the sample, fill the texts, run the done checks. Template changes keep `scripts/new-plugin.test.mjs` passing.
- A plugin that ships only skills has no `hooks/` and no `tsconfig.json`: write its manifest, `skills/<name>/SKILL.md`, docs and rule by hand. `claude plugin test` and `tsc` skip it (CI and the npm tasks), and check-consistency requires a skill instead.
- `node scripts/check-consistency.mjs` is the checklist: manifest and marketplace entry with the same description, `tsconfig.json`, `AGENTS.md`, `README.md`, `.claude/rules/<name>.md` (the line pointing at the plugin's AGENTS.md and no `@` import, `plugins/<name>/**` in `paths`), the backticked `plugins/<name>/AGENTS.md` under "Where to look" here, the root README table row and install line, the `ALL` list of `scripts/bootstrap.sh` (`plugin:new` updates it), and the template copies of `hooks/schema.ts` and `tests/schema-types.ts`. It fails on orphans (a plugin directory or rule file with no marketplace entry; other rules go in a subdirectory of `.claude/rules/`).
- Cite tests in a plugin AGENTS.md as `` `tests/<file>.test.ts` (`name`, `name`) `` or `` `tests/<file>.test.ts`: `name` `` (same for `helper/test/<file>.test.mjs`); the check fails on a missing file or undeclared name. A backticked support file under `tests/` or `helper/test/` must exist.

## CI

`.github/workflows/ci.yml` runs the consistency and bump checks, the script and helper tests, and `validate --strict` for every marketplace plugin and a scaffolded `ci-sample`, plus `test` for each one with hooks, then generates the typings in a session without login and runs `tsc` on each plugin and the sample, with the Claude Code CLI that `package.json` pins and `npm ci` installs. That exact version must equal the one the root README says the repository is checked with (`check-consistency`). Node comes from `.nvmrc`. The same job runs again on the latest CLI as `plugins-latest`, which may fail without failing the run: it shows what a newer CLI breaks before the pin moves. The `install` job runs `install:test`. The required checks are `checks` and `plugins`.

## Conventions

- README, docs, code comments and user-facing plugin messages in English.
- Conventional Commits in English for commits and PR titles; English PR descriptions (`.github/pull_request_template.md`).
- Refactor PRs diff `npm run plugins:scan` output before and after.
- Docs describe current behavior and how to use or contribute; history lives in git, and a rule explaining one line of code goes in a comment there.
