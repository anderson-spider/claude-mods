import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SOCKET_MAX, pathsOf, profileHolder, socketError } from '../lib/paths.mjs'

const paths = pathsOf('/h')

/** A host whose SingletonLock names `target`; `running` maps pids to their command name. */
const host = (target, running = {}) => ({
  read: path => {
    assert.equal(path, '/h/profile/SingletonLock')
    if (target === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return target
  },
  host: () => 'mac.local',
  alive: pid => Object.hasOwn(running, pid),
  command: pid => running[pid] ?? '',
})

test('the profile holder is a running Chromium on this machine, named by the SingletonLock link', () => {
  assert.equal(profileHolder(paths, host('mac.local-4242', { 4242: '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' })), 4242)
  assert.equal(profileHolder(paths, host('mac.local-4242', { 4242: 'chromium' })), 4242)
})

test('no lock, a lock of another machine, a dead pid or a pid reused by another program hold nothing', () => {
  assert.equal(profileHolder(paths, host(undefined)), undefined)
  assert.equal(profileHolder(paths, host('other.local-4242', { 4242: 'chromium' })), undefined)
  assert.equal(profileHolder(paths, host('mac.local-4242')), undefined)
  assert.equal(profileHolder(paths, host('mac.local-4242', { 4242: '/usr/bin/vim' })), undefined)
  assert.equal(profileHolder(paths, host('garbage')), undefined)
})

test('a socket path past what a Unix socket takes is named with its length', () => {
  assert.equal(socketError(paths), undefined)
  const long = pathsOf(`/${'x'.repeat(SOCKET_MAX)}`)
  assert.match(socketError(long), /is \d+ bytes, more than a Unix socket takes \(103\)/)
})
