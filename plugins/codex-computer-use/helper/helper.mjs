#!/usr/bin/env node
// The persistent codex-cu helper: an MCP client of the "codex-cu" connection
// (launch.mjs), one Codex session per caller, served to the codex-computer-use
// mod over a Unix socket in a directory only this user can enter.
import { connect } from 'node:net'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Approvals, CHOICES } from './lib/approvals.mjs'
import { Hub } from './lib/hub.mjs'
import { McpStdioClient } from './lib/mcp-client.mjs'
import { VERSION } from './lib/version.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'run')
const STATE = join(HERE, 'state')
const SOCKET = join(RUN, 'helper.sock')
const MAX_BODY = 1_000_000

const log = message => process.stderr.write(`${new Date().toISOString()} ${message}\n`)

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

// The routes this socket serves. hooks/model.ts holds the reply shape of each
// (`RouteReplies`) and the same `ROUTES`; helper/test/contract.mjs pins both lists
// and the key set of every reply.
export const ROUTES = {
  call: '/call',
  reset: '/reset',
  approve: '/approve',
  release: '/release',
  settings: '/settings',
  forget: '/forget',
  status: '/status',
}

const isCaller = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})?$/.test(value)

// The routes as written; `ROUTE_TABLE` below is the frozen copy the handler and the tests read.
const ROUTE_ENTRIES = {
  [ROUTES.status]: {
    anyMethod: true,
    run: hub => [200, { version: VERSION, pid: process.pid, ...hub.status() }],
  },
  [ROUTES.settings]: {
    caller: false,
    run: (hub, body) => {
      if (typeof body.autoApprove === 'boolean') {
        hub.approvals.setAutoApprove(body.autoApprove)
        log(`auto-approve ${body.autoApprove ? 'on' : 'off'}`)
      }

      return [200, { status: 'ok', settings: hub.approvals.settings }]
    },
  },
  [ROUTES.forget]: {
    caller: false,
    run: async (hub, body) => {
      const forgotten = await hub.forget(body.app)

      if (forgotten.status === 'ok') {
        log(`forgot always for ${forgotten.bundleId} (helper: ${forgotten.helper ? 'removed' : 'absent'}, codex: ${forgotten.codex})`)
      }

      return [forgotten.status === 'ok' ? 200 : 400, forgotten]
    },
  },
  [ROUTES.call]: { run: async (hub, body) => [200, await hub.call(body.caller, body)] },
  [ROUTES.reset]: { run: async (hub, body) => [200, await hub.reset(body.caller)] },
  [ROUTES.approve]: {
    run: (hub, body) => {
      if (typeof body.bundleId !== 'string' || !CHOICES.includes(body.choice)) {
        return [400, { status: 'error', message: `approve needs bundleId and choice ${CHOICES.join('|')}` }]
      }

      hub.approve(body.caller, body.bundleId, body.choice)
      log(`approval ${body.choice} for ${body.bundleId}`)

      return [200, { status: 'ok' }]
    },
  },
  [ROUTES.release]: { run: async (hub, body) => [200, await hub.release(body.caller)] },
}

/**
 * What each route does, keyed by the paths in `ROUTES`: `run(hub, body)` answers
 * `[status, reply]`. A route takes a valid `caller` in its body unless it says
 * `caller: false`, and takes POST only unless it says `anyMethod: true`, which also
 * skips reading the body. A new route is one entry here, its hub method and its
 * entries in hooks/model.ts and helper/test/contract.mjs. The table and its entries
 * are frozen: a route cannot be added or changed once the module is loaded.
 */
export const ROUTE_TABLE = Object.freeze(
  Object.fromEntries(Object.entries(ROUTE_ENTRIES).map(([path, route]) => [path, Object.freeze(route)])),
)

// The checks run in this order: /status (any method, no body), POST only, the JSON
// body, the caller, then the route. An unknown url is checked for a caller too, so a
// bad caller answers 400 before the 404.
export const handler = hub => async (request, response) => {
  const reply = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  try {
    const route = Object.hasOwn(ROUTE_TABLE, request.url) ? ROUTE_TABLE[request.url] : undefined

    if (route?.anyMethod) {
      return reply(...route.run(hub))
    }

    if (request.method !== 'POST') {
      return reply(405, { status: 'error', message: 'POST only' })
    }

    const body = JSON.parse((await readBody(request)) || '{}')

    if ((route === undefined || route.caller !== false) && !isCaller(body.caller)) {
      return reply(400, { status: 'error', message: 'caller must be "<session>" or "<session>/<agent>"' })
    }

    if (route === undefined) {
      return reply(404, { status: 'error', message: `unknown route ${request.url}` })
    }

    return reply(...(await route.run(hub, body)))
  } catch (error) {
    return reply(500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

const main = async () => {
  mkdirSync(RUN, { recursive: true, mode: 0o700 })
  chmodSync(RUN, 0o700)

  // One helper per user: a live socket means another one already serves.
  if (existsSync(SOCKET)) {
    if (await isLive(SOCKET)) {
      log('another helper is already listening; exiting')
      process.exit(0)
    }

    unlinkSync(SOCKET)
  }

  const hub = new Hub({
    approvals: new Approvals(join(STATE, 'approvals.json')),
    createClient: onElicit =>
      new McpStdioClient({ command: process.execPath, args: [join(HERE, 'launch.mjs')], onElicit }),
  })
  const sweeper = setInterval(() => hub.sweep(), 60_000)
  const server = createServer(handler(hub))

  server.listen(SOCKET, () => {
    chmodSync(SOCKET, 0o600)
    log(`codex-cu helper ${VERSION} listening (pid ${process.pid})`)
  })

  const stop = () => {
    clearInterval(sweeper)
    hub.close()
    server.close()

    try {
      unlinkSync(SOCKET)
    } catch {}

    process.exit(0)
  }

  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main()
}
