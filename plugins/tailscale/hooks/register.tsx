import type { Register } from 'claude-code'
import { WRITE_METHODS, call } from './api'

const PATH_HELP =
  'API path under https://api.tailscale.com/api/v2, starting with "/". "-" is the default tailnet (/tailnet/-/devices).'

const AREAS =
  'devices, ACL (policy file), DNS, API and auth keys, users, invites, tailnet settings, ' +
  'webhooks, logs, device posture, services, OAuth apps and contacts'

/** Shapes a call's output for the host: the result of a custom tool is a string, and `isError` is set only when true (the host rejects `false`). */
function reply(out: { text: string; isError: boolean }): { result: string } | { result: string; isError: true } {
  return out.isError ? { result: out.text, isError: true as const } : { result: out.text }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'tailscale_get',
      description:
        `Queries the Tailscale API (GET, read-only): ${AREAS}. ` +
        'No pagination: use "fields" to keep only the keys you need. ' +
        'Secret fields (*Key, *Secret, *Token) are removed. ' +
        'GET /tailnet/-/acl returns the ETag for the write ifMatch.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: PATH_HELP },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional. Keeps only these keys of the response, at any level.',
          },
        },
        required: ['path'],
      },
    })
    await $.tool.register({
      name: 'tailscale_write',
      description:
        'Modifies the tailnet through the Tailscale API (POST, PUT, PATCH or DELETE). ' +
        'Changes real state: confirm with the user first. Deleting the whole tailnet is refused. ' +
        'For POST /tailnet/-/acl, GET first and pass the ETag in ifMatch; a non-JSON string body is sent as HuJSON.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: [...WRITE_METHODS] },
          path: { type: 'string', description: 'Same as tailscale_get.' },
          body: { description: 'Request body: JSON object or string.' },
          ifMatch: {
            type: 'string',
            description: 'Optional. ETag from GET /tailnet/-/acl, with quotes.',
          },
        },
        required: ['method', 'path'],
      },
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__tailscale__tailscale_get' }, async ($, e) => {
    // The key is read on every call, never from options or the code.
    const key = await $.env.get('TS_API_KEY')
    const fields = Array.isArray(e.fields) ? e.fields.filter((f): f is string => typeof f === 'string') : undefined
    return reply(
      // $.http.fetch is wrapped, not passed as a value: the engine's validate rejects the latter.
      await call((url, init) => $.http.fetch(url, init), key, {
        method: 'GET',
        path: e.path,
        redact: true,
        fields,
      }),
    )
  })

  on('tool.call', { tool: 'mcp__tailscale__tailscale_write' }, async ($, e) => {
    const method = String(e.method).toUpperCase()
    if (!(WRITE_METHODS as readonly string[]).includes(method)) {
      return { deny: `Invalid method: ${method}. Use ${WRITE_METHODS.join(', ')}.` }
    }
    const key = await $.env.get('TS_API_KEY')
    const ifMatch = typeof e.ifMatch === 'string' ? e.ifMatch : undefined
    return reply(
      await call((url, init) => $.http.fetch(url, init), key, {
        method,
        path: e.path,
        body: e.body,
        ifMatch,
      }),
    )
  })
}
