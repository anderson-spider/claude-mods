// The OpenAPI spec is at https://api.tailscale.com/api/v2?outputOpenapiSchema=true (the /api-docs page is
// rendered by JS, so WebFetch cannot read it). The API declares itself unstable.
export const BASE = 'https://api.tailscale.com/api/v2'
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
  /** ETag value from a previous GET /acl, so the POST /acl does not overwrite someone else's edit. */
  ifMatch?: string
  /** Strips the REDACTED_FIELDS fields from the response. Only reads set it: a write response for a new key carries the secret once, and must reach the caller whole. */
  redact?: boolean
  /** Keeps only these keys (at any level) of the JSON response. */
  fields?: readonly string[]
}

/** Accepts only paths relative to the API (e.g. /tailnet/-/devices), without escaping the host. */
export function buildUrl(path: unknown): string | undefined {
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
  const url = BASE + path
  try {
    // second line: any client-side normalization of the path means `forbidden` saw another path than the server
    if (new URL(url).pathname !== new URL(BASE).pathname + pathPart) return undefined
  } catch {
    return undefined
  }
  return url
}

/** Operations the write tool never performs: deleting the whole tailnet (DELETE /tailnet/{tailnet}). */
export function forbidden(method: string, path: string): string | undefined {
  const bare = (path.split('?')[0] ?? '').replace(/\/+$/, '')
  if (method === 'DELETE' && /^\/tailnet\/[^/]+$/i.test(bare)) {
    return 'Deleting the entire tailnet (DELETE /tailnet/{tailnet}) is not done by this tool. Use the admin console.'
  }
  return undefined
}

/** Secret fields that must not reach the model in read responses. */
const REDACTED_FIELDS = new Set([
  'machineKey',
  'nodeKey',
  'tailnetLockKey',
  'secret',
  's3SecretAccessKey',
  'token',
])

/** The API is unstable, so a field it adds later that is named like a secret (authKey, clientSecret, accessToken) is dropped too. */
const SECRET_NAME = /(Key|Secret|Token)$/

const isSecret = (name: string): boolean => REDACTED_FIELDS.has(name) || SECRET_NAME.test(name)

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !isSecret(k))
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

/** Returns the path when `buildUrl` accepts it. */
export function checkedPath(path: unknown): string | undefined {
  return typeof path === 'string' && buildUrl(path) !== undefined ? path : undefined
}

/** Method, headers (auth, If-Match, content type) and body of the request. */
export function buildInit(
  req: Request,
  key: string,
): { method: string; headers: Record<string, string>; body?: string } {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  if (req.ifMatch) headers['If-Match'] = req.ifMatch
  let payload: string | undefined
  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      payload = req.body
      // a hand-written ACL policy (comments, trailing comma) is HuJSON, not JSON
      headers['Content-Type'] = isJson(payload) ? 'application/json' : 'application/hujson'
    } else {
      payload = JSON.stringify(req.body)
      headers['Content-Type'] = 'application/json'
    }
  }
  return { method: req.method, headers, body: payload }
}

/** Turns the response into the tool answer: status, ETag, transformed and truncated body. */
export function format(
  res: FetchResponse,
  req: Request,
): { text: string; isError: boolean } {
  const raw = transform(res.text, req)
  const text = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) + '\n…(truncated; use "fields" to request less)' : raw
  const etag = res.headers?.etag
  return { text: `HTTP ${res.status}\n${etag ? `ETag: ${etag}\n` : ''}${text}`, isError: !res.ok }
}

export async function call(
  fetch: Fetch,
  key: string | undefined,
  req: Request,
): Promise<{ text: string; isError: boolean }> {
  if (!key) return { text: 'TS_API_KEY is not set in the Claude Code environment.', isError: true }
  const path = checkedPath(req.path)
  const url = buildUrl(path)
  if (path === undefined || url === undefined) {
    return { text: `Invalid path: ${String(req.path)}. Use something like /tailnet/-/devices.`, isError: true }
  }
  const blocked = forbidden(req.method, path)
  if (blocked) return { text: blocked, isError: true }

  try {
    return format(await fetch(url, buildInit(req, key)), req)
  } catch (err) {
    return { text: `Call failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
