// gitlab_api: a read-only way out for what the other tools do not cover. GET only, on the remote's host, under a short
// allowlist of API prefixes; the path is checked here so it cannot climb out of /api/v4 or reach another host.
import type { McpToolInputs } from 'claude-code'
import { InputError, clip, need, str, type Ctx } from './context'

export type RawInput = { [K in keyof McpToolInputs['mcp__gitlab__gitlab_api']]?: unknown }

/** The prefixes a path may start with, each followed by `/`, `?` or the end. */
export const PREFIXES = ['projects', 'merge_requests', 'groups', 'users', 'labels'] as const

const SEGMENT = /^[\w.~%+:@-]+$/
const QUERY = /^[\w.~%+:@,=&[\]-]*$/

/** The checked path with its query, relative to /api/v4, or the reason it is refused. */
export function apiPath(value: unknown): string {
  const raw = need(str(value), 'gitlab_api needs path, relative to /api/v4 (projects/group%2Fproject/merge_requests?state=opened).').trim().replace(/^\/+/, '').replace(/^api\/v4\//, '')
  const at = raw.indexOf('?')
  const path = at < 0 ? raw : raw.slice(0, at)
  const query = at < 0 ? '' : raw.slice(at + 1)
  const segments = path.split('/')
  const allowed = `path must start with ${PREFIXES.join(', ')}.`
  if (!PREFIXES.includes(segments[0] as (typeof PREFIXES)[number])) throw new InputError(`gitlab_api reads only under /api/v4: ${allowed}`)
  if (segments.some((s) => !SEGMENT.test(s)) || !QUERY.test(query) || /%25/.test(raw)) throw new InputError('path has characters or an empty segment gitlab_api does not send.')
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    throw new InputError('path has a malformed %-escape.')
  }
  // an encoded slash may hide a dot segment GitLab or a proxy would resolve: check the decoded path too
  if (decoded.split('/').some((s) => s === '.' || s === '..') || decoded.includes('\\')) throw new InputError('path may not contain . or .. segments.')
  return query ? `${path}?${query}` : path
}

export async function rawGet(ctx: Ctx, input: RawInput): Promise<string> {
  const path = apiPath(input.path)
  const { text, next } = await ctx.api.raw(path)
  const tail = next === undefined ? '' : `\n(next page: ${next}; add page=${next} to the query)`
  return `${clip(text, 'add per_page or narrow the path')}${tail}`
}
