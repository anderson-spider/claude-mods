export const BASE = 'https://api.tailscale.com/api/v2'
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const

const MAX_CHARS = 60_000

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: string; headers?: Record<string, string> }>

export type Request = {
  method: string
  path: unknown
  body?: unknown
  /** ETag value from a previous GET /acl, so the POST /acl does not overwrite someone else's edit. */
  ifMatch?: string
  /** Strips the REDACTED_FIELDS fields from the response. */
  redact?: boolean
  /** Keeps only these keys (at any level) of the JSON response. */
  fields?: readonly string[]
}

/** Accepts only paths relative to the API (e.g. /tailnet/-/devices), without escaping the host. */
export function buildUrl(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined
  if (path.startsWith('//') || path.includes('..') || /[\s\\#]/.test(path)) return undefined
  // a server could normalize the encoded dot, slash or backslash
  if (/%(2e|2f|5c)/i.test(path)) return undefined
  return BASE + path
}

/** Operations the write tool never performs: deleting the whole tailnet (DELETE /tailnet/{tailnet}). */
export function forbidden(method: string, path: string): string | undefined {
  const bare = (path.split('?')[0] ?? '').replace(/\/+$/, '')
  if (method === 'DELETE' && /^\/tailnet\/[^/]+$/.test(bare)) {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !REDACTED_FIELDS.has(k))
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

export async function call(
  fetch: Fetch,
  key: string | undefined,
  req: Request,
): Promise<{ text: string; isError: boolean }> {
  if (!key) return { text: 'TS_API_KEY is not set in the Claude Code environment.', isError: true }
  const url = buildUrl(req.path)
  if (!url) {
    return { text: `Invalid path: ${String(req.path)}. Use something like /tailnet/-/devices.`, isError: true }
  }
  const blocked = forbidden(req.method, req.path as string)
  if (blocked) return { text: blocked, isError: true }

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

  try {
    const res = await fetch(url, { method: req.method, headers, body: payload })
    const raw = transform(res.text, req)
    const text = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) + '\n…(truncated; use "fields" to request less)' : raw
    const etag = res.headers?.etag
    return { text: `HTTP ${res.status}\n${etag ? `ETag: ${etag}\n` : ''}${text}`, isError: !res.ok }
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
