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
  /** Valor do ETag de um GET /acl anterior, para o POST /acl não sobrescrever edição alheia. */
  ifMatch?: string
  /** Tira os campos de REDACTED_FIELDS da resposta. */
  redact?: boolean
  /** Mantém só estas chaves (em qualquer nível) da resposta JSON. */
  fields?: readonly string[]
}

/** Aceita só caminhos relativos da API (ex.: /tailnet/-/devices), sem escapar do host. */
export function buildUrl(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined
  if (path.startsWith('//') || path.includes('..') || /[\s\\#]/.test(path)) return undefined
  // um servidor poderia normalizar o ponto, a barra ou a barra invertida codificados
  if (/%(2e|2f|5c)/i.test(path)) return undefined
  return BASE + path
}

/** Operações que a tool de escrita nunca faz: apagar a tailnet inteira (DELETE /tailnet/{tailnet}). */
export function forbidden(method: string, path: string): string | undefined {
  const bare = (path.split('?')[0] ?? '').replace(/\/+$/, '')
  if (method === 'DELETE' && /^\/tailnet\/[^/]+$/.test(bare)) {
    return 'Apagar a tailnet inteira (DELETE /tailnet/{tailnet}) não é feito por esta tool. Faça pelo console de administração.'
  }
  return undefined
}

/** Campos de segredo que não devem chegar ao modelo nas respostas de leitura. */
export const REDACTED_FIELDS = new Set([
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

/** Mantém só as chaves de `fields`; o que não cabe sai, e o que sobra vazio some. */
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

/** Remove os REDACTED_FIELDS em qualquer nível; texto que não é JSON passa intacto. */
export function redact(text: string): string {
  return transform(text, { redact: true })
}

/** Aplica `redact` e `fields` ao corpo; texto que não é JSON passa intacto. */
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
  if (!key) return { text: 'TS_API_KEY não está definida no ambiente do Claude Code.', isError: true }
  const url = buildUrl(req.path)
  if (!url) {
    return { text: `Caminho inválido: ${String(req.path)}. Use algo como /tailnet/-/devices.`, isError: true }
  }
  const blocked = forbidden(req.method, req.path as string)
  if (blocked) return { text: blocked, isError: true }

  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  if (req.ifMatch) headers['If-Match'] = req.ifMatch
  let payload: string | undefined
  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      payload = req.body
      // política de ACL escrita à mão (comentários, vírgula sobrando) é HuJSON, não JSON
      headers['Content-Type'] = isJson(payload) ? 'application/json' : 'application/hujson'
    } else {
      payload = JSON.stringify(req.body)
      headers['Content-Type'] = 'application/json'
    }
  }

  try {
    const res = await fetch(url, { method: req.method, headers, body: payload })
    const raw = transform(res.text, req)
    const text = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) + '\n…(cortado; use "fields" para pedir menos)' : raw
    const etag = res.headers?.etag
    return { text: `HTTP ${res.status}\n${etag ? `ETag: ${etag}\n` : ''}${text}`, isError: !res.ok }
  } catch (err) {
    return { text: `Falha na chamada: ${err instanceof Error ? err.message : String(err)}`, isError: true }
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
