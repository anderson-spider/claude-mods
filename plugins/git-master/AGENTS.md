# git-master

Usage/privacy: [README.md](README.md).
- `hooks/agent.ts`: the subagent definition (`GIT_MASTER`: name, description, model, effort, tools, prompt). `hooks/register.tsx`: its `$.agent.register` in `session.start`.
- Invariants: Haiku, git and conflict-fix tools only, never `Write` or `Agent` (`tests/register.test.ts`: `git-master works through git and conflict fixes only, and never delegates`); the prompt keeps the session's git rules, lease-guarded rewrites, human authorship and a stop before losing work (`tests/register.test.ts`: `its prompt keeps the session rules, lease-guarded rewrites, human authorship and a stop before losing work`).
- `tests/host.ts`: the host fake (`world`, `started`).
- Checks: [root commands](../../AGENTS.md#commands).
