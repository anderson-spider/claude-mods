// Path cases shared by the API and host tests. Each path rule is pinned here once; a test file loops over the tables.
import { BASE } from '../hooks/api'

/** Inputs `buildUrl` must refuse, grouped by the guard that refuses them (comments name the guard). */
export const REJECTED_GROUPS: Record<string, readonly unknown[]> = {
  // typeof path === 'string'
  'a value that is not a string': [undefined, null, 42, {}, { a: 1 }, ['/a']],
  // startsWith('/'): a scheme, a relative path or nothing
  'a path that does not start with a slash': ['https://evil.com', 'devices', ''],
  // includes('..'), also inside a segment
  'two dots anywhere': ['/a/../b', '/a/..', '/a..b'],
  // /[\s\\#\x00-\x1f\x7f]/: blanks, backslash, fragment and control characters
  'a blank, a backslash or a fragment': ['/a b', '/a\tb', '/a\nb', '/a\\b', '/a#b'],
  'a control character': [
    '/tailnet/-/\x00',
    '/tailnet/-/\x01',
    '/tailnet/-/\x7f',
    '/tailnet/-/.\x00',
    '/tailnet/-/.\x01',
    '/tailnet/\x01-',
    '/tailnet/-\x7f/x',
    '/tailnet/-/devices?x=\x01',
    '/TAILNET/-/\x01',
  ],
  // pathPart.includes('%'): the server decodes it past `forbidden`
  'a "%" in the path': ['/a/%2e%2e/b', '/a/%2E%2E/b', '/a%2Fb', '/a%5cb', '/%74ailnet/-', '/tailne%74/-', '/tailnet/%2d'],
  // an empty segment, except one trailing slash: the server may clean "//"
  'an empty segment': [
    '//evil.com/x',
    '/tailnet//-',
    '/tailnet/-//',
    '/tailnet///-',
    '//tailnet/-',
    '/tailnet//',
    '/TAILNET//-',
  ],
  // a "." segment, which the URL parser drops: at the start, middle, end or before the query
  'a lone dot segment': [
    '/.',
    '/./',
    '/./tailnet/-',
    '/tailnet/./-',
    '/tailnet/-/.',
    '/tailnet/-/./',
    '/tailnet/-/.?x=1',
    '/tailnet/./-?x=1',
    '/tailnet/-/devices/.',
    '/tailnet/././-',
    '/tailnet/./-/devices',
  ],
  // the URL parser percent-encodes or rewrites these, so only the pathname equality check refuses them
  'a path the URL parser rewrites': [
    '/a<b',
    '/tailnet/-/devices"x',
    '/tailnet/{x}',
    '/tailnet/-/。',
    '/tailnet/é/devices',
    '/a^b',
    '/a`b',
    '/tailnet/{x}?q=1',
  ],
}

export const REJECTED: readonly unknown[] = Object.values(REJECTED_GROUPS).flat()

/** Paths `buildUrl` maps to `BASE + path`, query string untouched. */
export const ACCEPTED: readonly string[] = [
  '/',
  '/tailnet/-/devices',
  '/tailnet/-/devices/', // a single trailing slash
  '/tailnet/-/',
  // a query string keeps "%", "." and "&"
  '/tailnet/-/devices?x=%20',
  '/tailnet/-/devices?x=%2f',
  '/a?q=%20b',
  '/tailnet/-/keys?all=true&x=1',
  '/tailnet/-/keys?host=a.b&v=1.2',
  '/tailnet/-/keys?fields=all&host=a.b',
  '/tailnet/-/devices?fields=all&host=a.b',
  // dots inside a segment
  '/tailnet/example.com/devices',
  '/device/100.64.0.1',
  '/device/100.64.0.1/tags',
  '/tailnet/.hidden/x',
  '/tailnet/a./x',
  '/tailnet/user@example.com/keys',
  '/device/abc123/routes',
  '/tailnet/-/devices?q="a"', // a quote in the query string is not a path character
]

export const urlOf = (path: string): string => BASE + path

/** Paths that DELETE the whole tailnet, in any case, with a trailing slash or a query string. */
export const TAILNET_DELETES: readonly string[] = [
  '/tailnet/-',
  '/tailnet/T1234CNTRL/',
  '/tailnet/-?x=1',
  '/tailnet/-?next=/x', // a slash in the query string must not hide the delete
  '/TAILNET/-',
  '/Tailnet/T1234CNTRL/',
  '/tailnet/example.com',
]

/** DELETEs the write tool must still send: only the whole-tailnet delete is forbidden. */
export const ALLOWED_DELETES: readonly string[] = ['/tailnet/-/keys/k1', '/tailnet/-/keys/k1?x=1', '/device/1', '/tailnet/-/x']

/** What the error text says for a path that `buildUrl` refused. */
export const invalidPathText = (path: unknown): string =>
  `Invalid path: ${String(path)}. Use something like /tailnet/-/devices.`
