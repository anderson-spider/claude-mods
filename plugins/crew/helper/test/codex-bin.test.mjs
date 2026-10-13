import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { binCandidates, candidates, DISABLED, findCodex, MCP_SERVERS, mcpServers, prepareHome, serverArgs, serverEnv, serverPath } from '../lib/codex-bin.mjs'

test('candidates are the link locations then the standalone releases, newest version first', () => {
  const list = () => ['0.9.0-x', '0.162.1-x', '0.20.0-x']
  const found = candidates('/home/u', list)

  assert.deepEqual(found.slice(0, 3), ['/home/u/.local/bin/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex'])
  assert.deepEqual(found.slice(3).map(path => path.split('/').at(-3)), ['0.162.1-x', '0.20.0-x', '0.9.0-x'])
})

test('the first executable candidate wins, and none is undefined; a missing releases directory is no failure', () => {
  const list = () => ['1.0.0']

  assert.equal(findCodex('/h', { list, can: path => path.includes('1.0.0') }), '/h/.codex/packages/standalone/releases/1.0.0/bin/codex')
  assert.equal(findCodex('/h', { list, can: () => false }), undefined)
  assert.equal(findCodex('/h', { list: () => { throw new Error('x') }, can: path => path === '/opt/homebrew/bin/codex' }), '/opt/homebrew/bin/codex')
})

test('the server runs with the user apps, plugins, hooks and desktop tools disabled', () => {
  const args = serverArgs()

  assert.equal(args.at(-1), 'app-server')
  assert.deepEqual(DISABLED, ['apps', 'plugins', 'hooks', 'computer_use', 'browser_use'])
  assert.deepEqual(args.slice(0, 10).filter((_, i) => i % 2 === 1), DISABLED)
  assert.deepEqual(args.slice(10, 16), ['-c', 'web_search="disabled"', '-c', 'allow_login_shell=false', '-c', 'shell_environment_policy.inherit="core"'])
})

test('the fixed MCP servers are Context7 by URL and CodeGraph by program, and nothing else', () => {
  assert.deepEqual(
    MCP_SERVERS.map(({ name, url, command, args }) => ({ name, url, command, args })),
    [
      { name: 'context7', url: 'https://mcp.context7.com/mcp', command: undefined, args: undefined },
      { name: 'codegraph', url: undefined, command: 'codegraph', args: ['serve', '--mcp'] },
    ],
  )
})

test('a server program is looked up by absolute path, and one that is not found leaves its server out', () => {
  assert.deepEqual(binCandidates('/h', 'codegraph'), ['/h/.local/bin/codegraph', '/opt/homebrew/bin/codegraph', '/usr/local/bin/codegraph'])
  assert.deepEqual(mcpServers('/h', { can: path => path === '/opt/homebrew/bin/codegraph' }).map(({ name, command }) => [name, command]), [
    ['context7', undefined],
    ['codegraph', '/opt/homebrew/bin/codegraph'],
  ])
  assert.deepEqual(mcpServers('/h', { can: () => false }).map(({ name }) => name), ['context7'])
})

test('a server program gets the directory of the helper\'s node first on its PATH, then the helper\'s PATH, with no repeats', () => {
  assert.equal(serverPath('/n/bin/node', '/usr/bin:/bin'), '/n/bin:/usr/bin:/bin')
  assert.equal(serverPath('/n/bin/node', '/usr/bin:/n/bin::/bin'), '/n/bin:/usr/bin:/bin')
  assert.equal(serverPath('/n/bin/node', ''), '/n/bin')

  const found = mcpServers('/h', { can: path => path === '/usr/local/bin/codegraph', path: '/n/bin:/usr/bin' })

  assert.deepEqual(found.map(({ name, env }) => [name, env]), [
    ['context7', undefined],
    ['codegraph', { PATH: '/n/bin:/usr/bin' }],
  ])
})

test('each resolved server is declared with -c after the shell settings and before the server, and none is the default', () => {
  const args = serverArgs(mcpServers('/h', { can: path => path === '/usr/local/bin/codegraph', path: '/n/bin:/usr/bin' }))

  assert.equal(args.at(-1), 'app-server')
  assert.deepEqual(args.slice(16, -1), [
    '-c', 'mcp_servers.context7.url="https://mcp.context7.com/mcp"',
    '-c', 'mcp_servers.codegraph.command="/usr/local/bin/codegraph"',
    '-c', 'mcp_servers.codegraph.args=["serve","--mcp"]',
    '-c', 'mcp_servers.codegraph.env.PATH="/n/bin:/usr/bin"',
  ])
  assert.equal(serverArgs().some(arg => arg.startsWith('mcp_servers.')), false)
})

test('the isolated home holds one link to the login and is not rewritten when it already points there', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-home-'))

  try {
    const user = join(root, 'user')
    mkdirSync(join(user, '.codex'), { recursive: true })
    const dir = join(root, 'isolated')

    assert.equal(prepareHome(dir, user), false)
    writeFileSync(join(user, '.codex/auth.json'), '{}')
    assert.equal(prepareHome(dir, user), true)
    assert.equal(readlinkSync(join(dir, 'auth.json')), join(user, '.codex/auth.json'))
    const before = lstatSync(join(dir, 'auth.json')).ino
    prepareHome(dir, user)
    assert.equal(lstatSync(join(dir, 'auth.json')).ino, before)
    assert.equal(lstatSync(join(dir, 'auth.json')).isSymbolicLink(), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the isolated home refuses to replace a file or directory that is not a link, and a home that is itself a link', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-home-'))

  try {
    const user = join(root, 'user')
    mkdirSync(join(user, '.codex'), { recursive: true })
    writeFileSync(join(user, '.codex/auth.json'), '{}')
    const dir = join(root, 'isolated')
    mkdirSync(dir)
    writeFileSync(join(dir, 'auth.json'), 'a copy')
    assert.throws(() => prepareHome(dir, user), /not a link/)
    assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), 'a copy')

    const linked = join(root, 'linked')
    symlinkSync(dir, linked)
    assert.throws(() => prepareHome(linked, user), /is a link/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a link to another login is replaced by the user\'s own, and nothing else is touched', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-home-'))

  try {
    const user = join(root, 'user')
    mkdirSync(join(user, '.codex'), { recursive: true })
    writeFileSync(join(user, '.codex/auth.json'), '{}')
    const dir = join(root, 'isolated')
    mkdirSync(dir)
    symlinkSync(join(root, 'elsewhere'), join(dir, 'auth.json'))
    prepareHome(dir, user)

    assert.equal(readlinkSync(join(dir, 'auth.json')), join(user, '.codex/auth.json'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the server env keeps what a shell needs and CODEX_HOME, and drops everything else', () => {
  const env = serverEnv({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', SECRET: 's', CODEX_HOME: '/user/.codex' }, '/isolated')

  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', LC_ALL: 'C', CODEX_HOME: '/isolated' })
})
