import assert from 'node:assert/strict'
import { cpSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { EventEmitter } from 'node:events'

import { isMain, startServer } from '../helper.mjs'
import { serverArgs } from '../lib/codex-bin.mjs'
import { temp } from './support.mjs'

// The main guard decides whether helper.mjs starts listening. Every run below is an isolated copy of the helper in a
// temp directory with a temp HOME: it never starts the installed helper, never touches the installed run/state
// directories, the LaunchAgent or the user's Codex home.
const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..')

const isolatedCopy = () => {
  const root = temp()
  const copy = join(root, 'helper')

  mkdirSync(copy)
  cpSync(join(HELPER, 'helper.mjs'), join(copy, 'helper.mjs'))
  cpSync(join(HELPER, 'lib'), join(copy, 'lib'), { recursive: true })
  const home = join(root, 'home')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex/auth.json'), '{}')

  return { root, copy, home }
}

const run = (args, env, ready) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => (child.kill('SIGKILL'), reject(new Error(`timeout; stderr: ${stderr}`))), 8000)

    child.stderr.on('data', chunk => {
      stderr += chunk

      if (ready?.(stderr)) {
        clearTimeout(timer)
        resolve({ child, stderr: () => stderr, done: new Promise(done => child.once('exit', done)) })
      }
    })
    child.once('exit', code => {
      clearTimeout(timer)
      resolve({ child, code, stderr: () => stderr, done: Promise.resolve(code) })
    })
  })

const statusOver = socketPath =>
  new Promise((resolve, reject) => {
    request({ socketPath, path: '/status', method: 'GET' }, response => {
      let text = ''
      response.on('data', chunk => (text += chunk))
      response.on('end', () => resolve(JSON.parse(text)))
    })
      .on('error', reject)
      .end()
  })

test('isMain is true for the file node started, through a symlink too, and false for anything else', () => {
  const { copy } = isolatedCopy()
  const real = join(copy, 'helper.mjs')
  const link = join(copy, 'link.mjs')
  symlinkSync(real, link)
  const here = join(HELPER, 'helper.mjs')

  assert.equal(isMain(here, here), true)
  assert.equal(isMain(link, here), false, 'a link to another file is another file')
  assert.equal(isMain(undefined, here), false)
  assert.equal(isMain(join(copy, 'missing.mjs'), here), false)
})

test('the copy listens when it is the main module, answers /status over its socket mode 0600, and stops on SIGTERM', async () => {
  const { copy, home } = isolatedCopy()
  const started = await run([join(copy, 'helper.mjs')], { ...process.env, HOME: home }, text => text.includes('listening'))
  const socket = join(copy, 'run', 'helper.sock')

  try {
    const status = await statusOver(socket)
    assert.equal(statSync(socket).mode & 0o777, 0o600)
    assert.equal(statSync(join(copy, 'run')).mode & 0o777, 0o700)
    assert.equal(statSync(join(copy, 'state')).mode & 0o777, 0o700)
    assert.equal(status.status, 'ok')
    assert.equal(status.login, true)
    assert.equal(typeof status.version, 'string')
  } finally {
    started.child.kill('SIGTERM')
  }

  assert.equal(await started.done, 0)
})

test('imported by another module it logs not started and does not listen', async () => {
  const { copy, home } = isolatedCopy()
  const importer = join(copy, 'importer.mjs')
  writeFileSync(importer, "await import('./helper.mjs')\n")
  const ran = await run([importer], { ...process.env, HOME: home })

  assert.equal(ran.code, 0)
  assert.match(ran.stderr(), /not started/)
})

test('--check reports the binary and the login and exits 1 when one is missing', async () => {
  const { copy, home } = isolatedCopy()
  const empty = join(copy, 'nohome')
  mkdirSync(empty)
  const ran = await run([join(copy, 'helper.mjs'), '--check'], { ...process.env, HOME: empty })

  assert.equal(ran.code, 1)
})

test('the server starts with the isolated home, the flags and the filtered environment, and a broken pipe does not take the helper down', () => {
  let seen
  const child = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdout = new EventEmitter()
  child.kill = () => {}
  startServer({
    codex: '/bin/codex',
    home: '/isolated',
    env: { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'k' },
    spawnFn: (...args) => ((seen = args), child),
  })

  assert.equal(seen[0], '/bin/codex')
  assert.deepEqual(seen[1], serverArgs())
  assert.deepEqual(seen[2].env, { PATH: '/bin', HOME: '/h', CODEX_HOME: '/isolated' })
  assert.deepEqual(seen[2].stdio, ['pipe', 'pipe', 'ignore'])
  assert.doesNotThrow(() => child.stdin.emit('error', new Error('EPIPE')))
  assert.doesNotThrow(() => child.stdout.emit('error', new Error('EPIPE')))
})
