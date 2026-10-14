import type { EngineInterface, McpToolInputs, Register } from 'claude-code'
import { WRITE_METHODS, call, type Request } from './api'
import { OFF_TEXT, resolveKey, type KeyIo } from './key'
import { allOf, type SchemaFor } from './schema'

const PATH_HELP =
  'API path under https://api.tailscale.com/api/v2, starting with "/". "-" is the default tailnet (/tailnet/-/devices).'

/** Shapes a call's output for the host: the result of a custom tool is a string, and `isError` is set only when true (the host rejects `false`). */
function reply(out: { text: string; isError: boolean }): { result: string } | { result: string; isError: true } {
  return out.isError ? { result: out.text, isError: true as const } : { result: out.text }
}

/** The repository's settings, which decide whether the key option may be used. */
function keyIo($: EngineInterface): KeyIo {
  return {
    settings: async (source) => {
      const settings = await $.settings.read({ source })
      return { pluginConfigs: settings?.pluginConfigs }
    },
  }
}

/** The host wiring every tool shares: resolves the key and calls the API. `$` is passed only to this top-level function so the engine's source analysis still sees each `$` call. */
async function run($: EngineInterface, req: Request, option: unknown): Promise<ReturnType<typeof reply>> {
  // The key comes from the `apiKey` option only, checked against the repository's settings on every call.
  const access = await resolveKey(keyIo($), option)
  if (access.off !== undefined) return reply({ text: OFF_TEXT[access.off], isError: true })
  // $.http.fetch is wrapped, not passed as a value: the engine's validate rejects the latter.
  return reply(await call((url, init) => $.http.fetch(url, init), access.key, req))
}

export const register: Register = (on, options) => {
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
          method: { type: 'string', enum: allOf<McpToolInputs['mcp__tailscale__tailscale_write']['method']>()(...WRITE_METHODS) },
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
    return run($, { method: 'GET', path: e.path, redact: true, fields }, options.apiKey)
  })

  on('tool.call', { tool: 'mcp__tailscale__tailscale_write' }, async ($, e) => {
    const method = String(e.method).toUpperCase()
    if (!(WRITE_METHODS as readonly string[]).includes(method)) {
      return { deny: `Invalid method: ${method}. Use ${WRITE_METHODS.join(', ')}.` }
    }
    const ifMatch = typeof e.ifMatch === 'string' ? e.ifMatch : undefined
    return run($, { method, path: e.path, body: e.body, ifMatch }, options.apiKey)
  })
}
