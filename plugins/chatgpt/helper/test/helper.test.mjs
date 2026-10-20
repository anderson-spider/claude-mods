import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { IDLE_MS, isMain, parseArgs } from '../helper.mjs'
import { VERSION } from '../lib/version.mjs'

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'helper.mjs')

test('each command takes --home, and the paths live under it', () => {
  const { command, paths } = parseArgs(['start', '--home', '/h'])
  assert.equal(command, 'start')
  assert.deepEqual(paths, {
    home: '/h',
    runtime: '/h/runtime',
    browsers: '/h/browsers',
    profile: '/h/profile',
    run: '/h/run',
    socket: '/h/run/helper.sock',
    log: '/h/helper.log',
  })
  for (const argv of [[], ['start'], ['start', '--home'], ['open', '--home', '/h'], ['stop', '/h']]) {
    assert.deepEqual(parseArgs(argv), { error: 'usage: helper.mjs <start|serve|stop|login> --home <dir>' })
  }
})

test('a wrong call prints the usage as JSON and exits 2', () => {
  let failure
  try {
    execFileSync(process.execPath, [HELPER, 'nope'], { encoding: 'utf8' })
  } catch (error) {
    failure = error
  }
  assert.equal(failure?.status, 2)
  assert.deepEqual(JSON.parse(failure.stdout), { status: 'error', message: 'usage: helper.mjs <start|serve|stop|login> --home <dir>' })
})

test('importing the module runs no command; only the file node runs is main', () => {
  assert.equal(isMain(HELPER), true)
  assert.equal(isMain(fileURLToPath(import.meta.url)), false)
  assert.equal(isMain(undefined), false)
  assert.equal(isMain('/no/such/file'), false)
})

test('the helper is the plugin version and idles out after ten minutes', () => {
  const manifest = JSON.parse(readFileSync(join(dirname(HELPER), '..', '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(VERSION, manifest.version)
  assert.equal(IDLE_MS, 600_000)
})
