import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'

import { socketError } from './paths.mjs'

const MAX_BODY = 5_000_000

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

/**
 * Serves the driver on `paths.socket` until `/stop`, or until `idleMs` pass with no request in flight; then closes
 * the browser, removes the socket and calls `exit`. Refuses to start while another daemon answers on the socket.
 */
export async function serve({ driver, paths, version, idleMs, exit, log }) {
  const tooLong = socketError(paths)
  if (tooLong) throw new Error(tooLong)
  mkdirSync(paths.run, { recursive: true, mode: 0o700 })
  chmodSync(paths.run, 0o700)
  if (existsSync(paths.socket)) {
    if (await isLive(paths.socket)) throw new Error(`a helper already answers on ${paths.socket}`)
    unlinkSync(paths.socket)
  }

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
      server.close()
      await driver.close().catch(error => log(`closing the browser failed: ${error?.message}`))
      if (existsSync(paths.socket)) unlinkSync(paths.socket)
      exit(0)
    })())

  const server = createServer(async (request, response) => {
    inflight++
    clearTimeout(timer)
    let reply
    try {
      const text = await readBody(request)
      const body = text ? JSON.parse(text) : {}
      reply = request.url === '/stop' ? { status: 'ok' } : await answer(driver, request.url, body, version)
    } catch (error) {
      reply = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    } finally {
      inflight--
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(reply))
    if (request.url === '/stop') void shutdown('stop')
    else if (!ending) arm()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(paths.socket, resolve)
  })
  chmodSync(paths.socket, 0o600)
  arm()
  log(`serving ${version} on ${paths.socket}`)
  return { server, shutdown }
}
