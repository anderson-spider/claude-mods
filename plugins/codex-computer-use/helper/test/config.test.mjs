import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { compareVersions, newestConfig, pickNewest, serverEnv } from '../lib/config.mjs'
import { temp } from './support.mjs'

test('newest config wins by numeric version and env keeps only the desktop surface', () => {
  assert.equal(pickNewest(['26.92.1', '26.930.61225', '26.930.9']), '26.930.61225')
  assert.equal(compareVersions('1.10', '1.9'), 1)

  const root = temp()

  for (const [version, command] of [['26.9.1', '/old'], ['26.930.61225', '/new']]) {
    mkdirSync(join(root, version))
    writeFileSync(
      join(root, version, '.mcp.json'),
      JSON.stringify({ mcpServers: { cua_repl: { command, args: ['a'], env: { CUA_REPL_ENABLED_SURFACES: 'browser,computer', X: '1' } } } }),
    )
  }

  const config = newestConfig(root)
  assert.equal(config.command, '/new')
  assert.equal(serverEnv({ HOME: '/h' }, config).CUA_REPL_ENABLED_SURFACES, 'computer')
  assert.throws(() => newestConfig(join(root, 'missing')), /not installed/)
})

test('install.sh --check writes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-cu-install-'))
  const script = fileURLToPath(new URL('../install.sh', import.meta.url))
  const ran = spawnSync('/bin/sh', [script, '--check'], { env: { ...process.env, HOME: home }, encoding: 'utf8' })

  if (ran.status === 0) {
    assert.match(ran.stdout, /ready to install/)
  } else {
    assert.equal(ran.status, 1)
    assert.match(ran.stderr, /codex-cu:/)
  }

  assert.deepEqual(readdirSync(home), [])

  const both = spawnSync('/bin/sh', [script, '--check', '--plugin-dir', home], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  assert.equal(both.status, 2)
  assert.deepEqual(readdirSync(home), [])
})
