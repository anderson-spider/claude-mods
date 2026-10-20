import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'

import { isAlive, socketError } from './paths.mjs'

const MAX_BODY = 5_000_000

// How long a stopping daemon lets the requests in flight finish before it closes the browser under them.
export const DRAIN_MS = 30_000

// How long a new daemon waits for the one before it to let go of the lock: only a stopping daemon's last moment
// (`start` spawns after the old socket went quiet). A second daemon spawned by a concurrent `start` gives up instead.
const LOCK_WAIT_MS = 1_000

/**
 * The routes, each answering a POST's JSON body with a reply that carries `status`; the hooks' adapter
 * (hooks/playwright-browser.ts) calls them by these paths. `/stop` is answered by `serve` itself, which then exits.
 */
export const ROUTE_TABLE = Object.freeze({
  '/health': (_driver, _body, version) => ({ status: 'ok', version }),
  '/tabs': async driver => ({ status: 'ok', tabs: await driver.tabs() }),
  '/open': async (driver, body) => ({ status: 'ok', tab: await driver.open(String(body.url)) }),
  '/wait': async (driver, body) => ({ status: 'ok', ok: await driver.wait(String(body.tab), String(body.fn), Number(body.timeoutMs)) }),
  '/eval': async (driver, body) => ({ status: 'ok', value: (await driver.eval(String(body.tab), String(body.body))) ?? null }),
  '/upload': async (driver, body) => {
    await driver.upload(String(body.tab), String(body.selector), Array.isArray(body.files) ? body.files : [])
    return { status: 'ok' }
  },
})

/** One route's reply; a driver that throws answers `{ status: 'error', message }`. */
export async function answer(driver, route, body, version) {
  const run = Object.hasOwn(ROUTE_TABLE, route) ? ROUTE_TABLE[route] : undefined
  if (!run) return { status: 'error', message: `no route ${route}` }
  try {
    return await run(driver, body, version)
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message.split('\n')[0] : String(error) }
  }
}

/** Whether something answers on the socket at `path`. */
export const isLive = path =>
  new Promise(resolve => {
    const socket = connect(path)
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
  })

const readBody = request =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request too large'))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Takes the lock only one `serve` per home holds. It appears whole, already naming this pid (a hard link of a file
 * written first), so a reader never sees it empty. A lock whose process is gone is taken over; one whose process runs
 * is waited for a moment (a daemon that is stopping), then refused while its socket answers. A holder that never
 * answers on the socket is a pid another process reused after a crash, and its lock is taken over too.
 */
export async function takeLock(path, { pid = process.pid, waitMs = LOCK_WAIT_MS, socket } = {}) {
  const deadline = Date.now() + waitMs
  const draft = `${path}.${pid}`
  writeFileSync(draft, String(pid), { mode: 0o600 })
  try {
    for (;;) {
      try {
        linkSync(draft, path)
        return
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      const holder = Number(readFileSync(path, 'utf8'))
      if (!holder || !isAlive(holder)) unlinkSync(path)
      else if (Date.now() < deadline) await sleep(100)
      else if (socket && !(await isLive(socket))) unlinkSync(path)
      else throw new Error(`a helper (pid ${holder}) already serves this home`)
    }
  } finally {
    rmSync(draft, { force: true })
  }
}

/**
 * Serves the driver on `paths.socket` until `/stop`, or until `idleMs` pass with no request in flight. Stopping lets
 * the requests in flight finish (up to `drainMs`), then closes the browser, then the socket, then the lock, and calls
 * `exit`: while it stops, `/health` says `stopping`, so no `start` takes the profile before the browser let go of it.
 */
export async function serve({ driver, paths, version, idleMs, exit, log, drainMs = DRAIN_MS, lockWaitMs = LOCK_WAIT_MS }) {
  const tooLong = socketError(paths)
  if (tooLong) throw new Error(tooLong)
  mkdirSync(paths.run, { recursive: true, mode: 0o700 })
  chmodSync(paths.run, 0o700)
  await takeLock(paths.lock, { waitMs: lockWaitMs, socket: paths.socket })
  // Only the lock holder touches the socket, so a socket file here is a dead daemon's.
  if (existsSync(paths.socket)) unlinkSync(paths.socket)

  let inflight = 0
  let timer
  let ending
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (inflight === 0) void shutdown('idle')
    }, idleMs)
  }

  const shutdown = reason =>
    (ending ??= (async () => {
      log(`stopping (${reason})`)
      clearTimeout(timer)
      const until = Date.now() + drainMs
      while (inflight > 0 && Date.now() < until) await sleep(50)
      await driver.close().catch(error => log(`closing the browser failed: ${error?.message}`))
      await new Promise(resolve => server.close(() => resolve()))
      // Forced: a folder removed under the daemon must not keep it from exiting.
      rmSync(paths.socket, { force: true })
      rmSync(paths.lock, { force: true })
      exit(0)
    })())

  const server = createServer(async (request, response) => {
    const route = request.url
    let reply
    if (ending) {
      reply = route === '/health' ? { status: 'stopping', version } : { status: 'error', message: 'the helper is stopping; try again' }
    } else {
      inflight++
      clearTimeout(timer)
      try {
        const text = await readBody(request)
        const body = text ? JSON.parse(text) : {}
        reply = route === '/stop' ? { status: 'ok' } : await answer(driver, route, body, version)
      } catch (error) {
        reply = { status: 'error', message: error instanceof Error ? error.message : String(error) }
      } finally {
        inflight--
      }
    }
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
    response.end(JSON.stringify(reply))
    if (route === '/stop') void shutdown('stop')
    else if (!ending) arm()
  })

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(paths.socket, resolve)
    })
  } catch (error) {
    rmSync(paths.lock, { force: true })
    throw error
  }
  chmodSync(paths.socket, 0o600)
  arm()
  log(`serving ${version} on ${paths.socket}`)
  return { server, shutdown }
}
