#!/usr/bin/env node
// The "codex-cu" connection: starts the newest installed Codex computer-use
// server (mcpServers.cua_repl) on this process's stdio. `--check` prints what it
// would start (no env values) and exits 1 when a prerequisite is missing.
import { spawn } from 'node:child_process'

import { check, newestConfig, serverEnv } from './lib/config.mjs'

if (process.argv.includes('--check')) {
  try {
    const report = check()
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exit(report.ok ? 0 : 1)
  } catch (error) {
    process.stderr.write(`codex-cu: ${error.message}\n`)
    process.exit(1)
  }
}

let config

try {
  config = newestConfig()
} catch (error) {
  process.stderr.write(`codex-cu: ${error.message}\n`)
  process.exit(1)
}

const child = spawn(config.command, config.args, { env: serverEnv(process.env, config), stdio: 'inherit' })

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', error => {
  process.stderr.write(`codex-cu: could not start ${config.command}: ${error.message}\n`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)))
