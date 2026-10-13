#!/usr/bin/env node
// The persistent crew Codex helper: one `codex app-server` (isolated Codex home, the user's login linked in), a Codex
// thread per crew agent, served to the crew plugin over a Unix socket in a directory only this user can enter.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findCodex, prepareHome, serverArgs } from './lib/codex-bin.mjs'
import { Engine } from './lib/engine.mjs'
import { RpcClient } from './lib/rpc.mjs'
import { VERSION } from './lib/version.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'run')
const STATE = join(HERE, 'state')
const SOCKET = join(RUN, 'helper.sock')
const CODEX_HOME = join(STATE, 'codex-home')
const MAX_BODY = 1_000_000

const log = message => process.stderr.write(`${new Date().toISOString()} ${message}\n`)

// The routes this socket serves. hooks/appserver.ts holds the same `ROUTES` and the reply shapes;
// helper/test/contract.mjs pins both lists and the key set of every reply.
export const ROUTES = {
  start: '/start',
  poll: '/poll',
  interrupt: '/interrupt',
  reset: '/reset',
  status: '/status',
}

export const isCaller = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)

const isLive = path =>
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
      } else {
        chunks.push(chunk)
      }
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

// The routes as written; `ROUTE_TABLE` below is the frozen copy the handler and the tests read. `run(engine, body, env)`
// answers `[status, reply]`; `env` is what the process knows (`codex` path, `login` present).
const ROUTE_ENTRIES = {
  [ROUTES.status]: {
    anyMethod: true,
    run: (engine, _body, env) => [200, { status: 'ok', version: VERSION, pid: process.pid, codex: env.codex() !== undefined, login: env.login(), ...engine.status() }],
  },
  [ROUTES.start]: {
    run: async (engine, body) => {
      const answered = await engine.start(body)

      return [answered.status === 'error' ? 400 : 200, answered]
    },
  },
  [ROUTES.poll]: { run: (engine, body) => [200, engine.poll(body.caller)] },
  [ROUTES.interrupt]: { run: async (engine, body) => [200, await engine.interrupt(body.caller)] },
  [ROUTES.reset]: { run: async (engine, body) => [200, await engine.reset(body.caller)] },
}

/**
 * What each route does, keyed by the paths in `ROUTES`. Every route but `/status` takes POST only and a valid
 * `caller` in its body; `anyMethod: true` (`/status`) skips both and reads no body. A new route is one entry here, its
 * engine method and its entries in hooks/appserver.ts and helper/test/contract.mjs. The table and its entries are
 * frozen.
 */
export const ROUTE_TABLE = Object.freeze(
  Object.fromEntries(Object.entries(ROUTE_ENTRIES).map(([path, route]) => [path, Object.freeze(route)])),
)

// The checks run in this order: /status (any method, no body), POST only, the JSON body, the caller, then the route.
// An unknown url is checked for a caller too, so a bad caller answers 400 before the 404.
export const handler = (engine, env) => async (request, response) => {
  const reply = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  try {
    const route = Object.hasOwn(ROUTE_TABLE, request.url) ? ROUTE_TABLE[request.url] : undefined

    if (route?.anyMethod) {
      return reply(...route.run(engine, {}, env))
    }

    if (request.method !== 'POST') {
      return reply(405, { status: 'error', message: 'POST only' })
    }

    const body = JSON.parse((await readBody(request)) || '{}')

    if (body === null || typeof body !== 'object' || !isCaller(body.caller)) {
      return reply(400, { status: 'error', message: 'caller must be a short id of letters, digits and ._:-' })
    }

    if (route === undefined) {
      return reply(404, { status: 'error', message: `unknown route ${request.url}` })
    }

    return reply(...(await route.run(engine, body, env)))
  } catch (error) {
    return reply(500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

/** Starts `codex app-server` in the isolated home and wraps it as an `RpcClient`. */
export const startServer = ({ codex, home = CODEX_HOME, env = process.env } = {}) => {
  const child = spawn(codex, serverArgs(), { env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] })
  let onExit = () => {}
  child.on('exit', () => onExit())
  child.on('error', () => onExit())

  return new RpcClient({
    stdin: child.stdin,
    stdout: child.stdout,
    kill: () => child.kill('SIGTERM'),
    onExit: fn => {
      onExit = fn
    },
  })
}

/** What the process finds on this machine: the `codex` binary and whether the login file is there. */
export const environment = (home = homedir()) => ({
  codex: () => findCodex(home),
  login: () => existsSync(join(home, '.codex/auth.json')),
})

/** True when this file is the one node was started with, through a symlink or not. */
export const isMain = (argv1 = process.argv[1], here = fileURLToPath(import.meta.url)) => {
  try {
    return argv1 !== undefined && realpathSync(argv1) === realpathSync(here)
  } catch {
    return false
  }
}

const check = () => {
  const env = environment()
  const report = { codex: env.codex() ?? null, login: env.login() }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

  return report.codex !== null && report.login
}

const main = async () => {
  if (process.argv.includes('--check')) {
    process.exit(check() ? 0 : 1)
  }

  mkdirSync(RUN, { recursive: true, mode: 0o700 })
  mkdirSync(STATE, { recursive: true, mode: 0o700 })
  chmodSync(RUN, 0o700)
  chmodSync(STATE, 0o700)

  // One helper per user: a live socket means another one already serves.
  if (existsSync(SOCKET)) {
    if (await isLive(SOCKET)) {
      log('another helper is already listening; exiting')
      process.exit(0)
    }

    unlinkSync(SOCKET)
  }

  const env = environment()
  prepareHome(CODEX_HOME, homedir())
  const engine = new Engine({
    createClient: () => {
      const codex = env.codex()

      if (codex === undefined) {
        throw new Error('no codex binary found (install the Codex CLI)')
      }

      return startServer({ codex })
    },
  })
  const sweeper = setInterval(() => engine.sweep().catch(() => {}), 30_000)
  const server = createServer(handler(engine, env))

  // A socket path that cannot be bound (too long, say) is a failed start, not an unhandled event.
  server.on('error', error => {
    log(`crew codex helper could not listen: ${error.message}`)
    process.exit(1)
  })
  server.listen(SOCKET, () => {
    chmodSync(SOCKET, 0o600)
    log(`crew codex helper ${VERSION} listening (pid ${process.pid})`)
  })

  const stop = () => {
    clearInterval(sweeper)
    engine.close()
    server.close()

    try {
      unlinkSync(SOCKET)
    } catch {}

    process.exit(0)
  }

  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (isMain()) {
  main().catch(error => {
    log(`crew codex helper failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
} else {
  log('crew codex helper: not started (not the main module)')
}
