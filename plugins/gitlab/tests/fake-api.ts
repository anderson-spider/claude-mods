// A fake GitLab API for the pure tool tests: records each call and answers from a route table keyed `METHOD path`.
import type { Api, Query } from '../hooks/api'
import { GitlabError } from '../hooks/api'
import type { Ctx } from '../hooks/context'

export type Call = { method: string; path: string; query?: Query; body?: Record<string, unknown> }
type Answer = string | number | boolean | null | readonly unknown[] | { [key: string]: unknown } | ((call: Call) => unknown)

/** A context on branch `branch` (null: a detached HEAD) whose API answers `routes[`${method} ${path}`]` (a value or a function of the call); an unknown route is a 404. */
export function fakeCtx(routes: Record<string, Answer>, branch: string | null = 'feature/x') {
  const calls: Call[] = []
  const answer = (call: Call) => {
    calls.push(call)
    const key = `${call.method} ${call.path}`
    if (!(key in routes)) throw new GitlabError(404, `404 Not found: ${key}`)
    const a = routes[key]
    return typeof a === 'function' ? (a as (c: Call) => unknown)(call) : a
  }
  const api: Api = {
    root: async (path, query) => answer({ method: 'GET', path: `ROOT${path}`, query }),
    get: async (path, query) => answer({ method: 'GET', path, query }),
    text: async (path) => String(answer({ method: 'GET', path })),
    send: async (method, path, body) => answer({ method, path, body }),
  }
  const ctx: Ctx = { api, branch: async () => branch ?? undefined }
  return { ctx, calls }
}

export const MR = {
  iid: 7,
  title: 'Add things',
  description: 'Body',
  state: 'opened',
  draft: false,
  source_branch: 'feature/x',
  target_branch: 'main',
  author: { username: 'ann' },
  assignees: [{ username: 'bob' }],
  reviewers: [],
  labels: ['feature'],
  detailed_merge_status: 'mergeable',
  has_conflicts: false,
  head_pipeline: { id: 90, status: 'failed' },
  web_url: 'https://gitlab.example.com/g/p/-/merge_requests/7',
  diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' },
}
