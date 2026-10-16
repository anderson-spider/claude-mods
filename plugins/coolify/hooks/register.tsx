import type { EngineInterface, McpToolInputs, Register } from 'claude-code'
import { OFF_TEXT, resolveAccess, type AccessIo } from './access'
import { WRITE_METHODS, call, deleteTarget, type Request } from './api'
import { allOf, type SchemaFor } from './schema'

const PATH_HELP =
  'API path under your instance\'s https://<url option>/api/v1, starting with "/", such as /projects or /applications/{uuid}.'

/** Shapes a call's output for the host: the result of a custom tool is a string, and `isError` is set only when true (the host rejects `false`). */
function reply(out: { text: string; isError: boolean }): { result: string } | { result: string; isError: true } {
  return out.isError ? { result: out.text, isError: true as const } : { result: out.text }
}

/** The user's and the repository's settings, which decide whether the url and apiKey options may be used. */
function accessIo($: EngineInterface): AccessIo {
  return {
    settings: async (source) => {
      const settings = await $.settings.read({ source })
      return { pluginConfigs: settings?.pluginConfigs }
    },
  }
}

/** The host wiring every tool shares: resolves the instance and token, then calls the API. `$` is passed only to this top-level function so the engine's source analysis still sees each `$` call. */
async function run($: EngineInterface, req: Request, options: { url?: unknown; apiKey?: unknown }): Promise<ReturnType<typeof reply>> {
  // The instance and token come from the options only, checked against the repository's settings on every call.
  const access = await resolveAccess(accessIo($), options)
  if (access.off !== undefined) return reply({ text: OFF_TEXT[access.off], isError: true })
  // $.http.fetch is wrapped, not passed as a value: the engine's validate rejects the latter.
  return reply(await call((url, init) => $.http.fetch(url, init), access, req))
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'coolify_get',
      description:
        'Read the Coolify API with GET: /projects, /resources, /applications, /services, /deployments. Answers past 60,000 characters are cut, so use fields to limit output. ' +
        'Passwords, tokens, private keys and environment variable values are filtered.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: PATH_HELP },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Response keys to keep, at any nesting level.',
          },
        },
        required: ['path'],
      } satisfies SchemaFor<McpToolInputs['mcp__coolify__coolify_get']>,
    })
    await $.tool.register({
      name: 'coolify_write',
      description:
        'Change Coolify after user confirmation; this writes real state. Create a project with POST /projects, deploy with POST /deploy?uuid=..., ' +
        'delete with DELETE /projects/{uuid}. Toggling the API or MCP server and creating tokens are refused.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: allOf<McpToolInputs['mcp__coolify__coolify_write']['method']>()(...WRITE_METHODS) },
          path: { type: 'string', description: PATH_HELP },
          body: { description: 'JSON object, or a JSON string.' },
          confirm: {
            type: 'string',
            description: 'For DELETE only: the id at the end of the path, repeated once the user has agreed to delete it.',
          },
        },
        required: ['method', 'path'],
      } satisfies SchemaFor<McpToolInputs['mcp__coolify__coolify_write']>,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__coolify__coolify_get' }, async ($, e) => {
    const fields = Array.isArray(e.fields) ? e.fields.filter((f): f is string => typeof f === 'string') : undefined
    return run($, { method: 'GET', path: e.path, redact: true, fields }, options)
  })

  on('tool.call', { tool: 'mcp__coolify__coolify_write' }, async ($, e) => {
    const method = String(e.method).toUpperCase()
    if (!(WRITE_METHODS as readonly string[]).includes(method)) {
      return { deny: `Invalid method: ${method}. Use ${WRITE_METHODS.join(', ')}.` }
    }
    if (method === 'DELETE') {
      // a deletion names its target twice, in the path and in `confirm`, so a wrong or stray path deletes nothing
      const target = deleteTarget(e.path)
      if (target === undefined || e.confirm !== target) {
        return { deny: `DELETE needs confirm set to the id at the end of the path${target ? ` ("${target}")` : ''}, after the user agrees to delete it.` }
      }
    }
    return run($, { method, path: e.path, body: e.body }, options)
  })
}
