import type { Register } from 'claude-code'
import { WRITE_METHODS, call } from './api'

const PATH_HELP =
  'Path relative to https://api.tailscale.com/api/v2, starting with "/". Use "-" for the default tailnet (e.g. /tailnet/-/devices).'

const AREAS =
  'devices, ACL (policy file), DNS, API and auth keys, users, invites, tailnet settings, ' +
  'webhooks, logs, device posture, services, OAuth apps and contacts'

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'tailscale_get',
      description:
        `Queries the Tailscale API (GET, read-only): ${AREAS}. ` +
        'Examples: /tailnet/-/devices, /tailnet/-/acl, /device/{id}, /tailnet/-/keys, /tailnet/-/settings. ' +
        'The API does not paginate: the full list comes back. Use "fields" to return only the keys that matter. ' +
        'Secret fields (machineKey, nodeKey, tailnetLockKey, secret, token) are removed. ' +
        'A GET on /tailnet/-/acl shows the ETag in the response: keep it for the POST ifMatch.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: PATH_HELP },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional. Keeps only these keys of the JSON response, at any level (e.g. ["hostname","addresses","os","lastSeen"]).',
          },
        },
        required: ['path'],
      },
    })
    await $.tool.register({
      name: 'tailscale_write',
      description:
        'Modifies the tailnet through the Tailscale API (POST, PUT, PATCH or DELETE): authorize/delete devices, ' +
        'set tags and routes, update ACL and DNS, create/revoke keys, webhooks and invites. ' +
        'Changes real state: confirm with the user first. Deleting the entire tailnet is refused. ' +
        'To update the ACL (POST /tailnet/-/acl), do a GET first and pass the ETag in ifMatch; ' +
        'a string body that is not valid JSON is sent as HuJSON.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: [...WRITE_METHODS] },
          path: { type: 'string', description: PATH_HELP },
          body: { description: 'Request body, if any: JSON object or string (JSON/HuJSON).' },
          ifMatch: {
            type: 'string',
            description: 'Optional. ETag from GET /tailnet/-/acl, with the quotes, so a concurrent edit is not overwritten.',
          },
        },
        required: ['method', 'path'],
      },
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__tailscale__tailscale_get' }, async ($, e) => {
    const key = await $.env.get('TS_API_KEY')
    const fields = Array.isArray(e.fields) ? e.fields.filter((f): f is string => typeof f === 'string') : undefined
    const { text, isError } = await call((url, init) => $.http.fetch(url, init), key, {
      method: 'GET',
      path: e.path,
      redact: true,
      fields,
    })
    return isError ? { result: text, isError: true as const } : { result: text }
  })

  on('tool.call', { tool: 'mcp__tailscale__tailscale_write' }, async ($, e) => {
    const method = String(e.method).toUpperCase()
    if (!(WRITE_METHODS as readonly string[]).includes(method)) {
      return { deny: `Invalid method: ${method}. Use ${WRITE_METHODS.join(', ')}.` }
    }
    const key = await $.env.get('TS_API_KEY')
    const ifMatch = typeof e.ifMatch === 'string' ? e.ifMatch : undefined
    const { text, isError } = await call((url, init) => $.http.fetch(url, init), key, {
      method,
      path: e.path,
      body: e.body,
      ifMatch,
    })
    return isError ? { result: text, isError: true as const } : { result: text }
  })
}
