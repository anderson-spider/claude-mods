import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { handler } from '../helper.mjs'
import { Approvals } from '../lib/approvals.mjs'
import { Hub } from '../lib/hub.mjs'
import { McpStdioClient } from '../lib/mcp-client.mjs'

export const FAKE = fileURLToPath(new URL('./fake-server.mjs', import.meta.url))
export const temp = () => mkdtempSync(join(tmpdir(), 'codex-cu-'))

export const hubWith = (approved = 'Calculator', extra = {}) => {
  const clients = []
  const hub = new Hub({
    approvals: new Approvals(join(temp(), 'approvals.json')),
    // Never the real ComputerUseAppApprovals.json.
    codexApprovals: join(temp(), 'codex-approvals.json'),
    resolve: async name => `com.fake.${name}`,
    createClient: onElicit => {
      const client = new McpStdioClient({
        command: process.execPath,
        args: [FAKE],
        env: { ...process.env, FAKE_APPROVED: approved },
        onElicit,
      })
      clients.push(client)

      return client
    },
    ...extra,
  })

  return { hub, clients }
}

/**
 * Runs the real `handler` on one request and reports what it answered. `payload` is
 * sent as JSON; `raw` replaces it with the exact text (including an invalid one).
 */
export const send = async (url, payload, { method = 'POST', hub, raw } = {}) => {
  const text = raw ?? (payload === undefined ? '' : JSON.stringify(payload))
  const request = Readable.from(text === '' ? [] : [Buffer.from(text)])
  request.url = url
  request.method = method
  let status
  let headers
  let body
  const response = {
    writeHead: (code, head) => ((status = code), (headers = head)),
    end: out => (body = JSON.parse(out)),
  }

  await handler(hub)(request, response)

  return { status, headers, body }
}

/**
 * A hub that answers every method the routes reach and records each call, by
 * name in `seen` and with its arguments in `calls`. `overrides` replace methods.
 */
export const stubHub = (overrides = {}) => {
  const seen = []
  const calls = []
  const note = (name, make) => (...args) => (seen.push(name), calls.push([name, ...args]), make(...args))

  return {
    seen,
    calls,
    call: note('call', (...args) => ({ status: 'ok', args })),
    reset: note('reset', (...args) => ({ status: 'ok', args })),
    approve: note('approve', (...args) => ({ status: 'ok', args })),
    release: note('release', (...args) => ({ status: 'ok', args })),
    forget: note('forget', () => ({ status: 'ok', bundleId: 'b', helper: true, codex: 'absent' })),
    status: note('status', () => ({})),
    approvals: { settings: { autoApprove: false, always: [] }, setAutoApprove: note('settings', () => undefined) },
    ...overrides,
  }
}

/** Runs `run` while collecting what the helper logs to stderr (without its timestamp), one entry per line. */
export const logged = async run => {
  const lines = []
  const write = process.stderr.write

  process.stderr.write = chunk => (lines.push(String(chunk).replace(/^\S+ /, '').trimEnd()), true)

  try {
    await run()
  } finally {
    process.stderr.write = write
  }

  return lines
}
