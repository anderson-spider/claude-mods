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

// How many times `start` and `stop` look again, `pause` apart, for the daemon to answer or to go.
export const TRIES = 40

const healthOf = (call, socket) => call(socket, '/health').catch(() => undefined)

/** Asks a running daemon to stop and waits until its socket goes quiet; true when none answers anymore. */
export async function stop({ paths, call = post, pause }) {
  if (!(await healthOf(call, paths.socket))) return true
  await call(paths.socket, '/stop').catch(() => undefined)
  for (let i = 0; i < TRIES; i++) {
    if (!(await healthOf(call, paths.socket))) return true
    await pause()
  }
  return false
}

/**
 * Makes sure a daemon of `version` serves on the socket: one of another version is stopped first, and a new one is
 * spawned (`spawnServe`) only when Playwright and Chromium are installed (`missing`). Answers `{ status: 'ok' }`,
 * `{ status: 'not-installed', missing }`, or `{ status: 'error', message }`.
 */
export async function start({ paths, version, call = post, pause, missing, spawnServe }) {
  const tooLong = socketError(paths)
  if (tooLong) return { status: 'error', message: tooLong }
  const health = await healthOf(call, paths.socket)
  if (health?.status === 'ok' && health.version === version) return { status: 'ok' }
  if (health && !(await stop({ paths, call, pause }))) {
    return { status: 'error', message: `the running helper (${health.version}) did not stop` }
  }
  const lacking = missing(paths)
  if (lacking) return { status: 'not-installed', missing: lacking }
  spawnServe()
  for (let i = 0; i < TRIES; i++) {
    await pause()
    const again = await healthOf(call, paths.socket)
    if (again?.status === 'ok' && again.version === version) return { status: 'ok' }
  }
  return { status: 'error', message: `the helper did not start; see ${paths.log}` }
}
