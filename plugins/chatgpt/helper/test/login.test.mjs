import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LOGIN_URL, appOf, login, windowCommand } from '../lib/login.mjs'
import { pathsOf } from '../lib/paths.mjs'

const MAC_EXE = '/h/browsers/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const PLAIN = ['--user-data-dir=/h/profile', '--no-first-run', '--no-default-browser-check']

test('on macOS the window opens as an app of its own through open; elsewhere the executable runs, Linux with the plaintext store', () => {
  assert.equal(appOf(MAC_EXE), '/h/browsers/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app')
  assert.deepEqual(windowCommand(MAC_EXE, '/h/profile', 'darwin'), [
    'open',
    '-n',
    '-a',
    '/h/browsers/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app',
    '--args',
    ...PLAIN,
    LOGIN_URL,
  ])
  assert.deepEqual(windowCommand('/h/chrome-linux/chrome', '/h/profile', 'linux'), ['/h/chrome-linux/chrome', ...PLAIN, '--password-store=basic', LOGIN_URL])
  assert.deepEqual(windowCommand('/h/chrome-linux/chrome', '/h/profile', 'darwin'), ['/h/chrome-linux/chrome', ...PLAIN, LOGIN_URL])
})

test('the window carries no automation flag and no debugging port', () => {
  for (const arg of windowCommand(MAC_EXE, '/h/profile', 'darwin')) assert.doesNotMatch(arg, /automation|remote-debugging|headless/)
})

function steps({ stopped = true, lacking = [] } = {}) {
  const log = []
  return {
    log,
    deps: {
      paths: pathsOf('/h'),
      stopDaemon: async () => (log.push('stop'), stopped),
      missing: () => lacking.shift(),
      install: async what => log.push(`install ${what}`),
      openWindow: async () => log.push('open'),
    },
  }
}

test('login stops the daemon, installs what is missing, then opens the window', async () => {
  const { log, deps } = steps({ lacking: ['runtime', undefined] })
  assert.deepEqual(await login(deps), { status: 'opened' })
  assert.deepEqual(log, ['stop', 'install runtime', 'open'])

  const ready = steps()
  assert.deepEqual(await login(ready.deps), { status: 'opened' })
  assert.deepEqual(ready.log, ['stop', 'open'])
})

test('a daemon that will not stop, or an install that leaves something missing, opens no window', async () => {
  const stuck = steps({ stopped: false })
  assert.deepEqual(await login(stuck.deps), { status: 'error', message: 'the running helper did not stop' })
  assert.deepEqual(stuck.log, ['stop'])

  const broken = steps({ lacking: ['runtime', 'browser'] })
  assert.deepEqual(await login(broken.deps), { status: 'error', message: 'the install finished but the browser is still missing' })
  assert.deepEqual(broken.log, ['stop', 'install runtime'])
})
