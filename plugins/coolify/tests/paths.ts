// Path cases shared by the API and host tests. Each path rule is pinned here once; a test file loops over the tables.

/** The API base the tests' `url` option resolves to. */
export const BASE = 'https://coolify.example.com/api/v1'

/** Inputs `buildUrl` must refuse, grouped by the guard that refuses them (comments name the guard). */
export const REJECTED_GROUPS: Record<string, readonly unknown[]> = {
  // typeof path === 'string'
  'a value that is not a string': [undefined, null, 42, {}, { a: 1 }, ['/a']],
  // startsWith('/'): a scheme, a relative path or nothing
  'a path that does not start with a slash': ['https://evil.com', 'projects', '', '@evil.com/x'],
  // includes('..'), also inside a segment
  'two dots anywhere': ['/a/../b', '/a/..', '/a..b', '/../../evil'],
  // /[\s\\#\x00-\x1f\x7f]/: blanks, backslash, fragment and control characters
  'a blank, a backslash or a fragment': ['/a b', '/a\tb', '/a\nb', '/a\\b', '/a#b'],
  'a control character': ['/projects/\x00', '/projects/\x01', '/projects/\x7f', '/projects/.\x01', '/projects?x=\x01'],
  // pathPart.includes('%'): the server decodes it past `forbidden`
  'a "%" in the path': ['/a/%2e%2e/b', '/a%2Fb', '/a%5cb', '/%65nable', '/projects/%2d'],
  // an empty segment, except one trailing slash: the server may clean "//"
  'an empty segment': ['//evil.com/x', '/projects//x', '/projects/x//', '//projects'],
  // a "." segment, which the URL parser drops
  'a lone dot segment': ['/.', '/./', '/./projects', '/projects/./x', '/projects/x/.', '/projects/x/.?y=1'],
  // the URL parser percent-encodes or rewrites these, so only the pathname equality check refuses them
  'a path the URL parser rewrites': ['/a<b', '/projects"x', '/projects/{uuid}', '/projects/é', '/a^b', '/a`b'],
}

export const REJECTED: readonly unknown[] = Object.values(REJECTED_GROUPS).flat()

/** Paths `buildUrl` maps to `BASE + path`, query string untouched. */
export const ACCEPTED: readonly string[] = [
  '/',
  '/projects',
  '/projects/', // a single trailing slash
  '/projects/abc123',
  '/projects/abc123/production',
  '/deploy?uuid=abc123&force=false',
  '/deploy?uuid=a,b&x=%20',
  '/applications/abc123?delete_volumes=false',
  '/applications/abc123/logs?lines=100',
  '/servers/a.b/domains', // dots inside a segment
  '/x?next=https://evil.com', // a URL in the query string stays in the query string
]

export const urlOf = (path: string): string => BASE + path

/** POSTs the write tool never sends, in any case, with a trailing slash or a query string. */
export const FORBIDDEN_POSTS: readonly string[] = [
  '/enable',
  '/disable',
  '/Disable/',
  '/mcp/enable',
  '/MCP/disable?x=1',
  '/security/integration-tokens',
]

/** DELETEs the write tool sends, each with the id `confirm` must repeat. */
export const DELETES: readonly (readonly [string, string])[] = [
  ['/projects/abc123', 'abc123'],
  ['/projects/abc123/', 'abc123'],
  ['/applications/App9?delete_volumes=false', 'App9'],
  ['/applications/abc/envs/env1', 'env1'],
]

/** What the error text says for a path that `buildUrl` refused. */
export const invalidPathText = (path: unknown): string => `Invalid path: ${String(path)}. Use something like /projects.`
