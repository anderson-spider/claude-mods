import type { EngineInterface, McpToolInputs, Register } from 'claude-code'
import { WRITE_METHODS, call, type Request } from './api'

const PATH_HELP =
  'API path under https://api.tailscale.com/api/v2, starting with "/". "-" is the default tailnet (/tailnet/-/devices).'

/** Every ordering of the union `U`, so a tuple of this type lists each member exactly once. Factorial: meant for up to ~6 members. */
type Permutations<U, A = U> = [U] extends [never] ? [] : A extends unknown ? [A, ...Permutations<Exclude<U, A>>] : never

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T]

/** The JSON Schema of one property, tied to the type `V` of the same property in `McpToolInputs`. A union of literals needs an `enum` listing each member once. */
type PropertySchema<V> = { description?: string } & (unknown extends V
  ? unknown
  : [V] extends [string]
    ? string extends V
      ? { type: 'string' }
      : { type: 'string'; enum: Permutations<V> }
    : [V] extends [readonly (infer I)[]]
      ? { type: 'array'; items: PropertySchema<I> }
      : never)

/**
 * Ties a tool's `inputSchema` to its `McpToolInputs` entry in types/index.d.ts: `satisfies SchemaFor<McpToolInputs[...]>`
 * fails tsc when the schema has a property the type lacks or omits one, when `required` is not exactly the type's
 * required keys (any order), when a property's `type` or `items` disagrees, or when a literal union lacks an `enum`
 * with exactly its members (any order). A property type the helper does not know (number, boolean, object) fails
 * closed. Descriptions and the `fields`/`body` semantics are not checked. Permutations: up to ~6 keys or members.
 */
type SchemaFor<T> = {
  type: 'object'
  properties: { [K in keyof T]-?: PropertySchema<Required<T>[K]> }
  required: Permutations<RequiredKeys<T>>
}

/** Shapes a call's output for the host: the result of a custom tool is a string, and `isError` is set only when true (the host rejects `false`). */
function reply(out: { text: string; isError: boolean }): { result: string } | { result: string; isError: true } {
  return out.isError ? { result: out.text, isError: true as const } : { result: out.text }
}

/** The host wiring every tool shares: reads the key and calls the API. `$` is passed only to this top-level function so the engine's source analysis still sees each `$` call. */
async function run($: EngineInterface, req: Request): Promise<ReturnType<typeof reply>> {
  // The key is read on every call, never from options or the code.
  const key = await $.env.get('TS_API_KEY')
  // $.http.fetch is wrapped, not passed as a value: the engine's validate rejects the latter.
  return reply(await call((url, init) => $.http.fetch(url, init), key, req))
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'tailscale_get',
      description:
        'Read the Tailscale API with GET. Lists are unpaginated; use fields to limit output. ' +
        'Secret fields (*Key, *Secret, *Token) are filtered. For ACL edits, GET /tailnet/-/acl first and keep its ETag.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: PATH_HELP },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Response keys to keep, at any nesting level.',
          },
        },
        required: ['path'],
      } satisfies SchemaFor<McpToolInputs['mcp__tailscale__tailscale_get']>,
    })
    await $.tool.register({
      name: 'tailscale_write',
      description:
        'Change tailnet resources after user confirmation; this writes real state. Whole-tailnet deletion is refused. ' +
        'For POST /tailnet/-/acl, GET first and pass its ETag in ifMatch. Write responses retain new-key secrets.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: [...WRITE_METHODS] },
          path: { type: 'string', description: PATH_HELP },
          body: { description: 'JSON object or string; non-JSON strings are sent as HuJSON.' },
          ifMatch: {
            type: 'string',
            description: 'Quoted ETag from GET /tailnet/-/acl; prevents overwriting a concurrent edit.',
          },
        },
        required: ['method', 'path'],
      } satisfies SchemaFor<McpToolInputs['mcp__tailscale__tailscale_write']>,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__tailscale__tailscale_get' }, async ($, e) => {
    const fields = Array.isArray(e.fields) ? e.fields.filter((f): f is string => typeof f === 'string') : undefined
    return run($, { method: 'GET', path: e.path, redact: true, fields })
  })

  on('tool.call', { tool: 'mcp__tailscale__tailscale_write' }, async ($, e) => {
    const method = String(e.method).toUpperCase()
    if (!(WRITE_METHODS as readonly string[]).includes(method)) {
      return { deny: `Invalid method: ${method}. Use ${WRITE_METHODS.join(', ')}.` }
    }
    const ifMatch = typeof e.ifMatch === 'string' ? e.ifMatch : undefined
    return run($, { method, path: e.path, body: e.body, ifMatch })
  })
}
