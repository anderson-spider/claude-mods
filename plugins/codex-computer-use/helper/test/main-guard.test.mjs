import assert from 'node:assert/strict'
import { cpSync, mkdirSync, symlinkSync } from 'node:fs'
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { isMain } from '../helper.mjs'
import { temp } from './support.mjs'

// The main guard decides whether helper.mjs starts listening. Every run below is an
// isolated copy of the helper in a temp directory: it never starts the installed helper,
// never touches the installed run/state directories or the LaunchAgent.
const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A copy of helper.mjs, launch.mjs and lib/ under a fresh temp directory; returns the directory. */
const isolatedCopy = () => {
  const root = temp()
  const copy = join(root, 'helper')

  mkdirSync(copy)
  cpSync(join(HELPER, 'helper.mjs'), join(copy, 'helper.mjs'))
  cpSync(join(HELPER, 'launch.mjs'), join(copy, 'launch.mjs'))
  cpSync(join(HELPER, 'lib'), join(copy, 'lib'), { recursive: true })

  return { root, copy }
}

/** Runs `node ...args`; resolves with what it wrote to stderr once `ready(stderr)` or it exits. */
const run = (args, ready) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => (child.kill('SIGKILL'), reject(new Error(`timeout; stderr: ${stderr}`))), 8000)

    child.stderr.on('data', chunk => {
      stderr += chunk

      if (ready?.(stderr)) {
        resolve({ child, stderr: () => stderr, done: new Promise(done => child.once('exit', done)) })
        clearTimeout(timer)
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

test('isMain compares real paths: a symlink to the module is the module, another file is not', () => {
  const { root, copy } = isolatedCopy()
  const real = join(copy, 'helper.mjs')
  const link = join(root, 'link.mjs')
  const other = join(copy, 'launch.mjs')

  symlinkSync(real, link)

  assert.equal(isMain(real, pathToFileURL(real).href), true)
  assert.equal(isMain(link, pathToFileURL(real).href), true, 'started through a symlink')
  assert.equal(isMain(real, pathToFileURL(link).href), true, 'the module url may be the symlink')
  assert.equal(isMain(other, pathToFileURL(real).href), false)
  assert.equal(isMain(undefined, pathToFileURL(real).href), false)
  assert.equal(isMain(join(root, 'missing.mjs'), pathToFileURL(real).href), false, 'a path that does not exist is not the module')
})

test('a helper started through a symlinked path still listens, beside the real file', async () => {
  const { root, copy } = isolatedCopy()
  const link = join(root, 'link.mjs')

  symlinkSync(join(copy, 'helper.mjs'), link)
  const started = await run([link], text => text.includes('listening'))

  try {
    assert.equal(started.code, undefined, `it kept running; stderr: ${started.stderr()}`)
    assert.equal((await statusOver(join(copy, 'run', 'helper.sock'))).pid, started.child.pid)
  } finally {
    started.child.kill('SIGTERM')
    await started.done
  }
})

test('a module that is imported, not started, says so on stderr and does not listen', async () => {
  const { copy } = isolatedCopy()
  const entry = pathToFileURL(join(copy, 'helper.mjs')).href
  const finished = await run(['--input-type=module', '-e', `await import(${JSON.stringify(entry)})`])

  assert.equal(finished.code, 0)
  assert.match(finished.stderr(), /not started: .*is not .*helper\.mjs/)
  assert.doesNotMatch(finished.stderr(), /listening/)
})
