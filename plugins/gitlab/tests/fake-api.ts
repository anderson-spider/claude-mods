// A fake GitLab API for the pure tool tests: records each call and answers from a route table keyed `METHOD path`.
import type { Api, Page, Query } from '../hooks/api'
import { GitlabError } from '../hooks/api'
import { makeCtx, type Ctx } from '../hooks/context'

export type Call = { method: string; path: string; query?: Query; body?: Record<string, unknown> }
type Answer = string | number | boolean | null | readonly unknown[] | { [key: string]: unknown } | ((call: Call) => unknown)

const PAGED = Symbol('paged')
/** An answer for a paged route that says GitLab has a next page (`X-Next-Page: next`). */
export const paged = (data: unknown, next?: number) => ({ [PAGED]: true, data, next })
const isPaged = (a: unknown): a is { data: unknown; next?: number } => typeof a === 'object' && a !== null && PAGED in a

/** The token's user in the fake: the author of `MR`, so writes on it pass the guard. */
export const ME = { id: 1, username: 'ann' }

/**
 * A context on branch `branch` (null: a detached HEAD) whose API answers `routes[`${method} ${path}`]` (a value or a
 * function of the call); an unknown route is a 404. `GET ROOT/user` answers `ME` unless a route says otherwise. Paths
 * under the API root are prefixed `ROOT`.
 */
export function fakeCtx(routes: Record<string, Answer>, branch: string | null = 'feature/x', foreign = false) {
  const calls: Call[] = []
  const table: Record<string, Answer> = { 'GET ROOT/user': ME, ...routes }
  const answer = (call: Call): unknown => {
    calls.push(call)
    const key = `${call.method} ${call.path}`
    if (!(key in table)) throw new GitlabError(404, `404 Not found: ${key}`, call.method)
    const a = table[key]
    return typeof a === 'function' ? (a as (c: Call) => unknown)(call) : a
  }
  const data = (a: unknown) => (isPaged(a) ? a.data : a)
  const page = (a: unknown): Page => (isPaged(a) ? { data: a.data, next: a.next } : { data: a })
  const api: Api = {
    root: async (path, query) => data(answer({ method: 'GET', path: `ROOT${path}`, query })),
    rootPage: async (path, query) => page(answer({ method: 'GET', path: `ROOT${path}`, query })),
    get: async (path, query) => data(answer({ method: 'GET', path, query })),
    page: async (path, query) => page(answer({ method: 'GET', path, query })),
    text: async (path) => String(answer({ method: 'GET', path })),
    send: async (method, path, body) => answer({ method, path, body }),
    url: (path) => `https://gitlab.example.com/api/v4/projects/g%2Fp${path}`,
  }
  // a clock that only moves when the code sleeps
  const clock = { at: 0, slept: [] as number[] }
  const ctx: Ctx = makeCtx(api, async () => branch ?? undefined, { now: () => clock.at, sleep: async (ms) => void (clock.slept.push(ms), (clock.at += ms)) }, foreign)
  /** The calls that write (POST, PUT, DELETE). */
  const writes = () => calls.filter((c) => c.method !== 'GET')
  return { ctx, calls, writes, clock }
}

export const MR = {
  iid: 7,
  title: 'Add things',
  description: 'Body',
  state: 'opened',
  draft: false,
  source_branch: 'feature/x',
  target_branch: 'main',
  sha: 'a'.repeat(40),
  author: { id: 1, username: 'ann' },
  assignees: [{ username: 'bob' }],
  reviewers: [],
  labels: ['feature'],
  detailed_merge_status: 'mergeable',
  has_conflicts: false,
  blocking_discussions_resolved: true,
  head_pipeline: { id: 90, status: 'failed', sha: 'a'.repeat(40), web_url: 'https://gitlab.example.com/g/p/-/pipelines/90' },
  web_url: 'https://gitlab.example.com/g/p/-/merge_requests/7',
  diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' },
}

/** `MR` written by someone else. */
export const THEIRS = { ...MR, author: { id: 2, username: 'bob' } }
