import { request as httpRequest } from 'node:http'

import { socketError } from './paths.mjs'

/** POSTs `body` to `route` on the socket and resolves its JSON reply; rejects when nothing answers. */
export const post = (socket, route, body = {}, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath: socket, path: route, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: timeoutMs },
      response => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', chunk => (text += chunk))
        response.on('end', () => {
          try {
            resolve(JSON.parse(text))
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error(`no answer on ${route} within ${timeoutMs} ms`)))
    request.end(JSON.stringify(body))
  })

// How many times `start` looks again, `pause` apart, for a new daemon to answer.
export const TRIES = 40

// How many times `stop` looks again for a daemon to go: it lets the requests in flight finish first (DRAIN_MS in
// server.mjs), then closes the browser.
export const STOP_TRIES = 200

// How long after `login` touched its mark a `start` keeps away from the profile, in ms.
export const LOGIN_GRACE_MS = 15_000

/** Whether version `a` is older than `b` (dotted numbers). */
export function older(a, b) {
  const parts = version => String(version).split('.').map(part => Number.parseInt(part, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  }
  return false
}

export const PROFILE_BUSY = 'another Chromium holds the profile (the /chatgpt-login window?): quit it (⌘Q on macOS), then try again'

const healthOf = (call, socket) => call(socket, '/health').catch(() => undefined)

/** Asks a running daemon to stop and waits until its socket goes quiet; true when none answers anymore. */
export async function stop({ paths, call = post, pause }) {
  if (!(await healthOf(call, paths.socket))) return true
  await call(paths.socket, '/stop').catch(() => undefined)
  for (let i = 0; i < STOP_TRIES; i++) {
    if (!(await healthOf(call, paths.socket))) return true
    await pause()
  }
  return false
}

/**
 * Makes sure a daemon serves on the socket. One of this version or newer is kept (a session that loaded an older
 * plugin uses it as is), one that is older is stopped first, and a new one is spawned (`spawnServe`) only when
 * Playwright and Chromium are installed (`missing`) and no other Chromium holds the profile (`profileHolder`, and the
 * mark a `login` in progress leaves, `loginAge`). Answers `{ status: 'ok' }`, `{ status: 'not-installed', missing }`,
 * or `{ status: 'error', message }`.
 */
export async function start({ paths, version, call = post, pause, missing, spawnServe, profileHolder, loginAge }) {
  const tooLong = socketError(paths)
  if (tooLong) return { status: 'error', message: tooLong }
  const health = await healthOf(call, paths.socket)
  if (health?.status === 'ok' && !older(health.version, version)) return { status: 'ok' }
  if (health && !(await stop({ paths, call, pause }))) {
    return { status: 'error', message: `the running helper (${health.version}) did not stop` }
  }
  const lacking = missing(paths)
  if (lacking) return { status: 'not-installed', missing: lacking }
  if (loginAge() < LOGIN_GRACE_MS || profileHolder(paths)) return { status: 'error', message: PROFILE_BUSY }
  spawnServe()
  for (let i = 0; i < TRIES; i++) {
    await pause()
    const again = await healthOf(call, paths.socket)
    if (again?.status === 'ok' && !older(again.version, version)) return { status: 'ok' }
  }
  return { status: 'error', message: `the helper did not start; see ${paths.log}` }
}
