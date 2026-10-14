// The GitLab REST API (v4) of one host and project. Pure: fetch is injected. Every path is built here from checked
// ids and the encoded project path, never taken from the model, so a call cannot leave its host or its project.

export type FetchResponse = { status: number; ok: boolean; text: string; headers?: Record<string, string> }
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>

export type Query = Record<string, string | number | boolean | undefined>

/** One page of a list, and the next page's number when GitLab says there is one (`X-Next-Page`). */
export type Page = { data: unknown; next?: number }

/** An answer the API refused, with its status, the request's method and GitLab's own message. */
export class GitlabError extends Error {
  readonly status: number
  readonly method: string
  constructor(status: number, message: string, method = 'GET') {
    super(message)
    this.status = status
    this.method = method
  }
}

export type Api = {
  /** GET under the API root (`/user`, `/users`), parsed JSON. */
  root: (path: string, query?: Query) => Promise<unknown>
  /** GET a page under the API root (`/merge_requests` of every project). */
  rootPage: (path: string, query?: Query) => Promise<Page>
  /** GET under the project, parsed JSON. */
  get: (path: string, query?: Query) => Promise<unknown>
  /** GET a page under the project. */
  page: (path: string, query?: Query) => Promise<Page>
  /** GET under the project, as text (a job log). */
  text: (path: string) => Promise<string>
  /** POST, PUT or DELETE under the project with a JSON body. */
  send: (method: 'POST' | 'PUT' | 'DELETE', path: string, body?: Record<string, unknown>) => Promise<unknown>
  /** The URL of a path under the project, for the model to show; it carries no token. */
  url: (path: string) => string
}

function search(query: Query = {}): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v))
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** GitLab's own message from an error body (`message` or `error`), cut short; the token is never part of it. */
export function errorMessage(text: string): string {
  let message: unknown = text
  try {
    const data = JSON.parse(text) as { message?: unknown; error?: unknown }
    message = data.message ?? data.error ?? text
  } catch {}
  const flat = typeof message === 'string' ? message : JSON.stringify(message)
  return flat.replace(/\s+/g, ' ').trim().slice(0, 500)
}

/** The next page's number from the response headers (lower-cased by the host), if any. */
export function nextPage(headers: Record<string, string> | undefined): number | undefined {
  const value = headers?.['x-next-page'] ?? headers?.['X-Next-Page']
  const n = value ? Number(value) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

export function gitlab(fetch: Fetch, host: string, project: string, token: string): Api {
  const base = `https://${host}/api/v4`
  const projectBase = `${base}/projects/${encodeURIComponent(project)}`

  async function request(method: string, url: string, body?: Record<string, unknown>): Promise<FetchResponse> {
    const headers: Record<string, string> = { 'PRIVATE-TOKEN': token, Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    if (!res.ok) throw new GitlabError(res.status, errorMessage(res.text), method)
    return res
  }
  const json = (res: FetchResponse): unknown => (res.text.trim() ? JSON.parse(res.text) : {})
  const page = (res: FetchResponse): Page => ({ data: json(res), next: nextPage(res.headers) })

  return {
    root: async (path, query) => json(await request('GET', base + path + search(query))),
    rootPage: async (path, query) => page(await request('GET', base + path + search(query))),
    get: async (path, query) => json(await request('GET', projectBase + path + search(query))),
    page: async (path, query) => page(await request('GET', projectBase + path + search(query))),
    text: async (path) => (await request('GET', projectBase + path)).text,
    send: async (method, path, body) => json(await request(method, projectBase + path, body)),
    url: (path) => projectBase + path,
  }
}
