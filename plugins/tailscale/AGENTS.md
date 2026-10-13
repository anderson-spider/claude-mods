# tailscale

Usage/privacy: [README.md](README.md). `hooks/register.tsx`: tools; `hooks/api.ts`: pure `call`, injected fetch.
- API/host tests: `tests/{tailscale,register}.test.ts`, fake fetch. `tests/paths.ts`: the path tables (`REJECTED_GROUPS`, `ACCEPTED`, `TAILNET_DELETES`, `ALLOWED_DELETES`), each rule pinned once. A new tool adds one `CALLS` entry in `register.test.ts` and its own cases.
- Checks: [root commands](../../AGENTS.md#commands).
