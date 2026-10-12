import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

test('normal install and uninstall keep settings and state in an isolated copied layout', () => {
  const root = temp()
  const home = join(root, 'home')
  const source = join(root, 'helper')
  const bin = join(root, 'bin')
  const target = join(home, '.claude/mcp/codex-cu')
  const state = join(target, 'state/approvals.json')
  const settings = join(home, '.claude/settings.json')
  const plist = join(home, 'Library/LaunchAgents/com.anderson-spider.codex-cu.plist')
  mkdirSync(join(target, 'state'), { recursive: true })
  mkdirSync(bin)
  cpSync(fileURLToPath(new URL('..', import.meta.url)), source, { recursive: true })
  // Only the temporary copy replaces the platform-specific Node and Codex prerequisites.
  // The production installer keeps its fixed executable; no real service is loaded.
  const installScript = join(source, 'install.sh')
  const installer = readFileSync(installScript, 'utf8')
  assert.match(installer, /^NODE=\/Applications\/ChatGPT\.app\/Contents\/Resources\/cua_node\/bin\/node$/m)
  const withNode = executable => installer.replace(/^NODE=.*$/m, () => `NODE='${executable.replaceAll("'", "'\\''")}'`)
  writeFileSync(join(source, 'launch.mjs'), 'process.exit(0)\n')
  writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\n[ "$1" != print ]\n', { mode: 0o700 })
  writeFileSync(state, '{"always":["com.fake.Editor"]}\n')
  writeFileSync(settings, '{"env":{"UNRELATED":"kept","CLAUDE_CODE_PLUGIN_DIRS":"/existing/plugin:/other/plugin"}}\n')
  const before = readFileSync(settings, 'utf8')
  const run = script => spawnSync('/bin/sh', [script], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
  })

  // Simulate the missing desktop-app executable without touching the installed app.
  const missingNode = join(root, 'missing-node')
  writeFileSync(installScript, withNode(missingNode))
  const refused = run(installScript)
  assert.equal(refused.status, 1)
  assert.ok(refused.stderr.includes(`codex-cu: ${missingNode} is missing.`))
  assert.equal(existsSync(plist), false)
  assert.equal(existsSync(join(target, 'helper.mjs')), false)
  assert.equal(readFileSync(settings, 'utf8'), before)
  assert.equal(readFileSync(state, 'utf8'), '{"always":["com.fake.Editor"]}\n')

  // Exercise installation on Linux too, using the same Node that runs this test.
  writeFileSync(installScript, withNode(process.execPath))
  const installed = run(installScript)
  assert.equal(installed.status, 0, installed.stderr)
  assert.equal(readFileSync(settings, 'utf8'), before)
  assert.deepEqual(readdirSync(join(home, '.claude')).sort(), ['mcp', 'settings.json'])
  assert.match(readFileSync(plist, 'utf8'), /helper\.mjs/)
  assert.ok(existsSync(join(target, 'run')))
  assert.ok(existsSync(join(target, 'helper.mjs')))

  const uninstalled = run(join(target, 'uninstall.sh'))
  assert.equal(uninstalled.status, 0, uninstalled.stderr)
  assert.equal(existsSync(plist), false)
  assert.equal(readFileSync(settings, 'utf8'), before)
  assert.equal(readFileSync(state, 'utf8'), '{"always":["com.fake.Editor"]}\n')
  assert.ok(existsSync(join(target, 'helper.mjs')))
})

test('removed development install flags are usage errors without filesystem changes', () => {
  const home = temp()
  for (const name of ['install', 'uninstall']) {
    const script = fileURLToPath(new URL(`../${name}.sh`, import.meta.url))
    for (const args of [['--plugin-dir', home], ['--plugin-dir'], ['--unknown']]) {
      const ran = spawnSync('/bin/sh', [script, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
      assert.equal(ran.status, 2)
      assert.match(ran.stderr, new RegExp(`usage: ${name}\\.sh`))
      assert.deepEqual(readdirSync(home), [])
    }
  }
})
