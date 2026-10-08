import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach } from 'node:test'

import { AppServerClient } from '../lib/app-server-client.mjs'

export const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))
export const temp = () => mkdtempSync(join(tmpdir(), 'threads-helper-'))

const opened = []

// A client on the fake app-server, closed after its test. Never the real `codex`.
export const fakeClient = (options = {}) => {
  const client = new AppServerClient({ command: process.execPath, args: [FAKE], ...options })
  opened.push(client)

  return client
}

afterEach(() => {
  for (const client of opened.splice(0)) {
    client.close()
  }
})

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export const waitFor = async (check, timeoutMs = 3000) => {
  const started = Date.now()

  for (;;) {
    const value = check()

    if (value) {
      return value
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for the condition')
    }

    await sleep(10)
  }
}
