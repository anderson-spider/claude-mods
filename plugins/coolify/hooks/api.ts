import { OFF_TEXT } from './access'

// The OpenAPI spec is openapi.yaml at the root of github.com/coollabsio/coolify; the same paths are
// documented at https://coolify.io/docs/api-reference. Every path is relative to the instance's /api/v1.
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const

const MAX_CHARS = 60_000

type FetchResponse = { status: number; ok: boolean; text: string; headers?: Record<string, string> }

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<FetchResponse>

export type Request = {
  method: string
  path: unknown
  body?: unknown
  /** Strips secret fields from the response. Only reads set it: a write may return a value the caller has to keep. */
  redact?: boolean
  /** Keeps only these keys (at any level) of the JSON response. */
  fields?: readonly string[]
}

/** Accepts only paths relative to the API base (e.g. /projects), without escaping the host. */
export function buildUrl(base: string, path: unknown): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined
  // the URL parser strips trailing C0 controls and tabs/newlines, so any of them could hide a segment
  if (path.includes('..') || /[\s\\#\x00-\x1f\x7f]/.test(path)) return undefined
  const pathPart = path.split('?')[0] ?? ''
  // the server decodes "%" and may clean "//", and the URL parser drops "." segments, past `forbidden`;
  // only a single trailing slash may leave an empty segment
  if (pathPart.includes('%')) return undefined
  const segments = pathPart.split('/').slice(1)
  if (segments.at(-1) === '') segments.pop()
  if (segments.some((s) => s === '' || s === '.')) return undefined
  const url = base + path
  try {
    // second line: any client-side normalization of the path means `forbidden` saw another path than the server
    const parsed = new URL(url)
    if (parsed.origin !== new URL(base).origin || parsed.pathname !== new URL(base).pathname + pathPart) return undefined
  } catch {
    return undefined
  }
  return url
}

/** The path without its query string and trailing slashes, lower-cased, as `forbidden` and `deleteTarget` compare it. */
const bare = (path: string): string => (path.split('?')[0] ?? '').replace(/\/+$/, '').toLowerCase()

/** Writes that switch the instance's own API or MCP server, or mint a token: a call could lock the user out or widen its own access. */
const FORBIDDEN_POSTS = new Set(['/enable', '/disable', '/mcp/enable', '/mcp/disable', '/security/integration-tokens'])

/** Operations the write tool never performs. */
export function forbidden(method: string, path: string): string | undefined {
  if (method === 'POST' && FORBIDDEN_POSTS.has(bare(path))) {
    return 'Turning the Coolify API or MCP server on or off, or creating tokens, is not done by this tool. Use the Coolify dashboard.'
  }
  return undefined
}

/** The id a DELETE removes: the last segment of its path, which `confirm` must repeat. */
export function deleteTarget(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined
  const segments = (path.split('?')[0] ?? '').replace(/\/+$/, '').split('/')
  return segments.at(-1) || undefined
}

/** Field names that carry a secret in Coolify answers (snake_case): passwords, tokens, private keys, webhook secrets. */
const SECRET_NAME = /(password|passwd|secret|token|private_key|api_key|_key$)/i

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** An environment variable (`{ key, value, real_value, ... }`): its name stays, its value does not. */
const isEnv = (value: Record<string, unknown>): boolean => typeof value.key === 'string' && ('value' in value || 'real_value' in value)

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (isObject(value)) {
    const env = isEnv(value)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !SECRET_NAME.test(k) && !(env && (k === 'value' || k === 'real_value')))
        .map(([k, v]) => [k, strip(v)]),
    )
  }
  return value
}

function isEmpty(value: unknown): boolean {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  return isObject(value) && Object.keys(value).length === 0
}

/** Keeps only the `fields` keys; what does not fit is dropped, and what is left empty disappears. */
function pick(value: unknown, fields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => pick(v, fields)).filter((v) => !isEmpty(v))
  }
  if (!isObject(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (fields.has(k)) out[k] = v
    else {
      const sub = pick(v, fields)
      if (!isEmpty(sub)) out[k] = sub
    }
  }
  return out
}

/** Applies `redact` and `fields` to the body; text that is not JSON passes through intact. */
export function transform(text: string, opts: { redact?: boolean; fields?: readonly string[] }): string {
  if (!opts.redact && !opts.fields?.length) return text
  try {
    let data: unknown = JSON.parse(text)
    if (opts.redact) data = strip(data)
    if (opts.fields?.length) data = pick(data, new Set(opts.fields)) ?? {}
    return JSON.stringify(data)
  } catch {
    return text
  }
}

/** Method, headers (auth, content type) and JSON body of the request. */
export function buildInit(
  req: Request,
  key: string,
): { method: string; headers: Record<string, string>; body?: string } {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  let payload: string | undefined
  if (req.body !== undefined) {
    payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    headers['Content-Type'] = 'application/json'
  }
  return { method: req.method, headers, body: payload }
}

/** Turns the response into the tool answer: status, transformed and truncated body. */
export function format(res: FetchResponse, req: Request): { text: string; isError: boolean } {
  const raw = transform(res.text, req)
  const text = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) + '\n…(truncated; use "fields" to request less)' : raw
  return { text: `HTTP ${res.status}\n${text}`, isError: !res.ok }
}

export async function call(
  fetch: Fetch,
  access: { key?: string; base?: string },
  req: Request,
): Promise<{ text: string; isError: boolean }> {
  if (!access.key) return { text: OFF_TEXT['no-key'], isError: true }
  if (!access.base) return { text: OFF_TEXT['no-url'], isError: true }
  // the one path validation: `buildUrl` returns base + path, so the checked path is what follows the base
  const url = buildUrl(access.base, req.path)
  if (url === undefined) {
    return { text: `Invalid path: ${String(req.path)}. Use something like /projects.`, isError: true }
  }
  const blocked = forbidden(req.method, url.slice(access.base.length))
  if (blocked) return { text: blocked, isError: true }

  try {
    return format(await fetch(url, buildInit(req, access.key)), req)
  } catch (err) {
    return { text: `Call failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}
