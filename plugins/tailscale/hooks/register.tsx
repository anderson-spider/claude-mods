import type { Register } from 'claude-code'
import { WRITE_METHODS, call, type Fetch, type Request } from './api'

const PATH_HELP =
  'API path under https://api.tailscale.com/api/v2, starting with "/". "-" is the default tailnet (/tailnet/-/devices).'

/** Shapes a call's output for the host: the result of a custom tool is a string, and `isError` is set only when true (the host rejects `false`). */
function reply(out: { text: string; isError: boolean }): { result: string } | { result: string; isError: true } {
  return out.isError ? { result: out.text, isError: true as const } : { result: out.text }
}

/** Reads the key and calls the API; host access arrives as functions because `$` is only used in `on(...)` handlers. */
async function run(
  readKey: () => Promise<string | undefined>,
  fetch: Fetch,
  req: Request,
): Promise<ReturnType<typeof reply>> {
  return reply(await call(fetch, await readKey(), req))
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
      },
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
      },
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__tailscale__tailscale_get' }, async ($, e) => {
    const fields = Array.isArray(e.fields) ? e.fields.filter((f): f is string => typeof f === 'string') : undefined
    // The key is read on every call, never from options or the code.
    // $.http.fetch is wrapped, not passed as a value: the engine's validate rejects the latter.
    return run(() => $.env.get('TS_API_KEY'), (url, init) => $.http.fetch(url, init), {
      method: 'GET',
      path: e.path,
      redact: true,
      fields,
    })
  })

  on('tool.call', { tool: 'mcp__tailscale__tailscale_write' }, async ($, e) => {
    const method = String(e.method).toUpperCase()
    if (!(WRITE_METHODS as readonly string[]).includes(method)) {
      return { deny: `Invalid method: ${method}. Use ${WRITE_METHODS.join(', ')}.` }
    }
    const ifMatch = typeof e.ifMatch === 'string' ? e.ifMatch : undefined
    return run(() => $.env.get('TS_API_KEY'), (url, init) => $.http.fetch(url, init), {
      method,
      path: e.path,
      body: e.body,
      ifMatch,
    })
  })
}
