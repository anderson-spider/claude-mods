# spider-progress

Usage/privacy: [README.md](README.md).
- `hooks/register.tsx`: each tool's literal `session.start` registration (`inputSchema ... satisfies SchemaFor<McpToolInputs[...]>`: tsc fails when the schema's properties, `required`, `type`/`items` differ from `types/index.d.ts` or a literal union's `enum` is not `allOf` of exactly its members; descriptions are unchecked) and its `tool.call` hook. `hooks/schema.ts`: the shared `SchemaFor` and `allOf` (`enum` slots take only `allOf` of exactly the union), a byte-for-byte copy of the template's that `scripts/check-consistency.mjs` enforces, with its type cases in `tests/schema-types.ts`. `hooks/echo.ts`: the sample tool's pure logic.
- Tests mirror modules: `tests/echo.test.ts`, `tests/register.test.ts` (`session start registers the echo tool`). `tests/host.ts`: the host fake (`world`, `started`) that host tests share.
- Checks: [root commands](../../AGENTS.md#commands).
