import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { handler } from '../helper.mjs'
import { Engine } from '../lib/engine.mjs'
import { RpcClient } from '../lib/rpc.mjs'
import { fakeChild, nominal } from './fake-server.mjs'

export const temp = () => mkdtempSync(join(tmpdir(), 'crew-codex-'))

/** What the process would find: a codex binary and a login, unless a test says otherwise. */
export const envWith = (over = {}) => ({ codex: () => '/bin/codex', login: () => true, ...over })

/** A real engine over a fake `codex app-server`; the turns finish on their own with `text`. */
export const engineWith = (options = {}) => {
  const fake = fakeChild({ autoComplete: true, text: 'done', ...options })

  return { fake, engine: new Engine({ createClient: () => new RpcClient(fake.child), resolve: nominal }) }
}

/**
 * Runs the real `handler` on one request and reports what it answered. `payload` is sent as JSON; `raw` replaces it
 * with the exact text (including an invalid one).
 */
export const send = async (url, payload, { method = 'POST', engine, env = envWith(), raw } = {}) => {
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

  await handler(engine ?? engineWith().engine, env)(request, response)

  return { status, headers, body }
}

/** An engine that records its calls and answers a fixed reply for each. */
export const stubEngine = () => {
  const seen = []

  return {
    seen,
    start: async body => (seen.push(['start', body]), { status: 'started' }),
    poll: caller => (seen.push(['poll', caller]), { status: 'idle' }),
    interrupt: async caller => (seen.push(['interrupt', caller]), { status: 'ok', interrupted: false }),
    reset: async caller => (seen.push(['reset', caller]), { status: 'ok' }),
    status: () => ({ jobs: 0, threads: 0 }),
  }
}
