#!/usr/bin/env node
// The chatgpt plugin's own browser: a headless Chromium driven through Playwright, served to the plugin's hooks
// over a Unix socket (lib/server.mjs). Usage: `node helper.mjs <start|serve|stop|login> --home <dir>`.
//
// - start: makes sure a daemon of this version serves, spawning `serve` detached; prints `ok`, `not-installed` or `error`.
// - serve: the daemon; it exits after IDLE_MS without a request.
// - stop: ends the daemon.
// - login: stops the daemon, installs Playwright and Chromium when missing, and opens the login window.
//
// Every command but `serve` prints one JSON line on stdout; progress and installer output go to stderr.
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { start, stop } from './lib/daemon.mjs'
import { createDriver } from './lib/driver.mjs'
import { installSteps, loadPlaywright, missing } from './lib/install.mjs'
import { login, windowCommand } from './lib/login.mjs'
import { pathsOf } from './lib/paths.mjs'
import { serve } from './lib/server.mjs'
import { VERSION } from './lib/version.mjs'

const SELF = fileURLToPath(import.meta.url)

// How long the daemon stays up with nothing to do; the next request starts it again.
export const IDLE_MS = 10 * 60_000

const log = message => process.stderr.write(`${new Date().toISOString()} ${message}\n`)

const pause = () => new Promise(resolve => setTimeout(resolve, 250))

/** Runs one install step with its output on stderr; rejects when it fails. */
const runStep = argv =>
  new Promise((resolve, reject) => {
    log(`running ${argv.join(' ')}`)
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 2, 2], env: process.env })
    child.once('error', reject)
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`${argv.slice(0, 2).join(' ')} exited with ${code}`))))
  })

/** The command, its `--home` and the paths under it, or a usage error. */
export function parseArgs(argv) {
  const [command, flag, home] = argv
  if (!['start', 'serve', 'stop', 'login'].includes(command) || flag !== '--home' || !home) {
    return { error: 'usage: helper.mjs <start|serve|stop|login> --home <dir>' }
  }
  return { command, paths: pathsOf(home) }
}

const COMMANDS = {
  start: paths =>
    start({
      paths,
      version: VERSION,
      pause,
      missing,
      spawnServe: () => {
        mkdirSync(paths.home, { recursive: true })
        const out = openSync(paths.log, 'a')
        spawn(process.execPath, [SELF, 'serve', '--home', paths.home], { detached: true, stdio: ['ignore', out, out], env: process.env }).unref()
        closeSync(out)
      },
    }),

  stop: async paths => ((await stop({ paths, pause })) ? { status: 'ok' } : { status: 'error', message: 'the helper did not stop' }),

  login: paths =>
    login({
      paths,
      stopDaemon: () => stop({ paths, pause }),
      missing,
      install: async lacking => {
        mkdirSync(paths.runtime, { recursive: true })
        for (const argv of installSteps(paths, lacking, process.execPath)) await runStep(argv)
      },
      openWindow: async () => {
        const [command, ...args] = windowCommand(loadPlaywright(paths).chromium.executablePath(), paths.profile, process.platform)
        spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
      },
    }),

  serve: async paths => {
    const driver = createDriver({ chromium: loadPlaywright(paths).chromium, profile: paths.profile, readFile: path => readFile(path) })
    const { shutdown } = await serve({ driver, paths, version: VERSION, idleMs: IDLE_MS, exit: code => process.exit(code), log })
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown(signal))
  },
}

/** Whether this file is the one node was asked to run (a start through a symlink counts). */
export function isMain(argv1 = process.argv[1]) {
  try {
    return argv1 !== undefined && realpathSync(argv1) === realpathSync(SELF)
  } catch {
    return false
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    process.stdout.write(`${JSON.stringify({ status: 'error', message: parsed.error })}\n`)
    process.exit(2)
  }
  // playwright-core reads where its browsers are when it loads.
  process.env.PLAYWRIGHT_BROWSERS_PATH = parsed.paths.browsers
  try {
    const result = await COMMANDS[parsed.command](parsed.paths)
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'error', message: error instanceof Error ? error.message : String(error) })}\n`)
    process.exit(1)
  }
}

if (isMain()) await main()
