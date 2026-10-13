import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { candidates, DISABLED, findCodex, prepareHome, serverArgs, serverEnv } from '../lib/codex-bin.mjs'

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
  assert.deepEqual(args.slice(10, 12), ['-c', 'web_search="disabled"'])
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
