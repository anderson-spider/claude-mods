#!/usr/bin/env node
// The threads helper: one `codex app-server` child per user, served to the threads
// plugin over a Unix socket in a directory only this user can enter. The helper
// exits when the child does, so the next caller starts a fresh pair.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AppServerClient } from './lib/app-server-client.mjs'
import { handler } from './lib/http.mjs'
import { Threads } from './lib/threads.mjs'

const HOME = join(homedir(), '.claude', 'threads-codex')
const RUN = join(HOME, 'run')
const STATE = join(HOME, 'state')
const SOCKET = join(RUN, 'helper.sock')
const THREADS_FILE = join(STATE, 'threads.json')
const LOG_FILE = join(STATE, 'helper.log')

// The plugin version this helper ships with, so the plugin can tell an outdated helper that
// survived an update. Empty when the manifest cannot be read.
const versionOf = () => {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json')

    return String(JSON.parse(readFileSync(manifest, 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

const log = message => {
  const line = `${new Date().toISOString()} ${message}\n`
  process.stderr.write(line)

  try {
    appendFileSync(LOG_FILE, line, { mode: 0o600 })
  } catch {}
}

const isLive = path =>
  new Promise(resolve => {
    const socket = connect(path)
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
  })

// Written whole and renamed, so a reader never sees half a file.
const save = snapshot => {
  const tmp = `${THREADS_FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, THREADS_FILE)
}

const main = async () => {
  mkdirSync(RUN, { recursive: true, mode: 0o700 })
  chmodSync(RUN, 0o700)
  mkdirSync(STATE, { recursive: true, mode: 0o700 })

  // One helper per user: a live socket means another one already serves.
  if (existsSync(SOCKET)) {
    if (await isLive(SOCKET)) {
      log('another helper is already listening; exiting')
      process.exit(0)
    }

    unlinkSync(SOCKET)
  }

  let server
  const stop = code => {
    try {
      unlinkSync(SOCKET)
    } catch {}

    client.close()
    server?.close()
    process.exit(code)
  }

  const client = new AppServerClient({ command: 'codex', args: ['app-server'] })
  const threads = new Threads({ client, persist: save, log })
  threads.attach()
  // Registered after the threads, so the state file is written before the exit.
  client.onExit(reason => {
    log(`codex app-server is gone: ${reason}`)
    stop(1)
  })

  try {
    await client.start()
  } catch (error) {
    log(`could not start codex app-server: ${error instanceof Error ? error.message : String(error)}`)
    stop(1)

    return
  }

  server = createServer(handler({ threads, log, version: versionOf() }))
  // A socket path over the Unix limit (about 104 bytes on macOS) fails here, not in the handler.
  server.on('error', error => {
    log(`could not listen on ${SOCKET}: ${error.message}`)
    stop(1)
  })
  server.listen(SOCKET, () => {
    chmodSync(SOCKET, 0o600)
    log(`threads helper listening (pid ${process.pid})`)
  })

  process.on('SIGTERM', () => stop(0))
  process.on('SIGINT', () => stop(0))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main()
}
