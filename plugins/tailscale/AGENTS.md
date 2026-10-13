# tailscale

Usage/privacy: [README.md](README.md).
- `hooks/register.tsx`: each tool's literal `session.start` registration (`inputSchema ... satisfies SchemaFor<McpToolInputs[...]>`, tsc fails when the schema's properties, `required`, `type`/`items` or literal-union `enum` differ from `types/index.d.ts`; descriptions are unchecked) and `tool.call` hook, all sharing the top-level `run($, req)` (key, fetch adapter, result); `hooks/api.ts`: pure `call`, injected fetch, one path validation (`buildUrl`).
- API/host tests: `tests/{tailscale,register}.test.ts`, fake fetch. `tests/paths.ts`: the path tables (`REJECTED_GROUPS`, `ACCEPTED`, `TAILNET_DELETES`, `ALLOWED_DELETES`), each rule pinned once. A new tool adds one `CALLS` entry in `register.test.ts` and its own cases.
- Checks: [root commands](../../AGENTS.md#commands).
