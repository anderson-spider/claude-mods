#!/usr/bin/env node
// The persistent codex-cu helper: an MCP client of the "codex-cu" connection
// (launch.mjs), one Codex session per caller, served to the codex-computer-use
// mod over a Unix socket in a directory only this user can enter.
import { connect } from 'node:net'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Approvals } from './lib/approvals.mjs'
import { Hub } from './lib/hub.mjs'
import { McpStdioClient } from './lib/mcp-client.mjs'
import { VERSION } from './lib/version.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = process.env.CODEX_CU_RUN_DIR ?? join(HERE, 'run')
const STATE = process.env.CODEX_CU_STATE_DIR ?? join(HERE, 'state')
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

// The wire contract, mirrored from plugins/codex-computer-use/hooks/model.ts
// (`ROUTES`, `Reply`); keep the two in step.
/**
 * @typedef {{ bundleId: string, displayName: string, canAlways?: boolean }} AppRef
 * @typedef {'session' | 'always' | 'deny'} Choice The person's answer to an approval question.
 * @typedef {{ type: string, text?: string, data?: string, mimeType?: string }} ContentBlock
 * @typedef {{ autoApprove: boolean, always: string[] }} Settings
 *
 * A `/call` answers one of:
 * @typedef {{ status: 'ok', isError: boolean, content: ContentBlock[], notes?: string[] }} CallReply
 * @typedef {{ status: 'needs_approval', app: AppRef, text?: string }
 *   | { status: 'denied', app: AppRef, text?: string }
 *   | { status: 'busy', app: AppRef, owner: string, idleSeconds?: number, text?: string }
 *   | { status: 'full', message: string }} Held
 * @typedef {{ status: 'error', message: string, notes?: string[] }} Failure
 *
 * The other routes:
 * @typedef {{ status: 'ok', message: string }} ResetReply `/reset`
 * @typedef {{ status: 'ok', ended: string[] }} ReleaseReply `/release`
 * @typedef {{ status: 'ok', bundleId: string, helper: boolean, codex?: 'removed' | 'absent' | 'missing' }} ForgetReply `/forget`
 * @typedef {{ status: 'ok', settings?: Settings }} SettingsReply `/settings` (`/approve` answers a bare `ok`)
 * @typedef {{ version: string, pid: number, callers: { caller: string, apps: string[], isFresh: boolean, idleSeconds: number }[],
 *   owners: Record<string, { owner: string, idleSeconds: number }>, settings: Settings }} StatusReply `/status`, which has no `status` field
 */
const isCaller = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})?$/.test(value)

export const handler = hub => async (request, response) => {
  const reply = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  try {
    if (request.url === '/status') {
      return reply(200, { version: VERSION, pid: process.pid, ...hub.status() })
    }

    if (request.method !== 'POST') {
      return reply(405, { status: 'error', message: 'POST only' })
    }

    const body = JSON.parse((await readBody(request)) || '{}')

    if (request.url === '/settings') {
      if (typeof body.autoApprove === 'boolean') {
        hub.approvals.setAutoApprove(body.autoApprove)
        log(`auto-approve ${body.autoApprove ? 'on' : 'off'}`)
      }

      return reply(200, { status: 'ok', settings: hub.approvals.settings })
    }

    if (request.url === '/forget') {
      const forgotten = await hub.forget(body.app)

      if (forgotten.status === 'ok') {
        log(`forgot always for ${forgotten.bundleId} (helper: ${forgotten.helper ? 'removed' : 'absent'}, codex: ${forgotten.codex})`)
      }

      return reply(forgotten.status === 'ok' ? 200 : 400, forgotten)
    }

    if (!isCaller(body.caller)) {
      return reply(400, { status: 'error', message: 'caller must be "<session>" or "<session>/<agent>"' })
    }

    switch (request.url) {
      case '/call':
        return reply(200, await hub.call(body.caller, body))
      case '/reset':
        return reply(200, await hub.reset(body.caller))
      case '/approve':
        if (typeof body.bundleId !== 'string' || !['session', 'always', 'deny'].includes(body.choice)) {
          return reply(400, { status: 'error', message: 'approve needs bundleId and choice session|always|deny' })
        }

        hub.approve(body.caller, body.bundleId, body.choice)
        log(`approval ${body.choice} for ${body.bundleId}`)

        return reply(200, { status: 'ok' })
      case '/release':
        return reply(200, hub.release(body.caller))
      default:
        return reply(404, { status: 'error', message: `unknown route ${request.url}` })
    }
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
