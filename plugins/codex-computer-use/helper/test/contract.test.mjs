import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { handler } from '../helper.mjs'
import { contract } from './contract.mjs'

// The helper's half of the contract with hooks/helper.ts, over the examples in
// contract.mjs; the plugin's half is tests/contract.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url))

/** Runs the real `handler` on one POST /release and reports the status it answered; the hub is a stub, so only the caller check decides. */
const releaseStatus = async caller => {
  const released = []
  const hub = { release: value => (released.push(value), { status: 'ok', ended: [value] }) }
  const request = Readable.from([Buffer.from(JSON.stringify({ caller }))])
  request.url = '/release'
  request.method = 'POST'
  let status
  let body
  const response = {
    writeHead: code => (status = code),
    end: text => (body = JSON.parse(text)),
  }

  await handler(hub)(request, response)

  return { status, body, released }
}

test('the helper accepts every caller callerOf makes, and the session and agent parts up to the limit', async () => {
  for (const { caller } of contract.callers) {
    const answered = await releaseStatus(caller)
    assert.equal(answered.status, 200, `caller ${JSON.stringify(caller)}`)
    assert.deepEqual(answered.released, [caller])
  }

  const longest = 'a'.repeat(contract.maxPart)
  assert.equal((await releaseStatus(longest)).status, 200)
  assert.equal((await releaseStatus(`${longest}/${longest}`)).status, 200)
  assert.equal((await releaseStatus(`${longest}a`)).status, 400)
  assert.equal((await releaseStatus(`a/${longest}a`)).status, 400)
})

test('the helper refuses every shape the shared examples mark as not a caller, and a missing or non-string one', async () => {
  for (const refused of contract.notCallers) {
    const answered = await releaseStatus(refused)
    assert.equal(answered.status, 400, `caller ${JSON.stringify(refused)}`)
    assert.equal(answered.body.status, 'error')
    assert.deepEqual(answered.released, [])
  }

  for (const refused of [undefined, null, 7, ['a'], { caller: 'a' }]) {
    assert.equal((await releaseStatus(refused)).status, 400)
  }
})

// Static, so nothing is started: where install.sh installs the helper plus where helper.mjs puts its socket beside itself.
test('install.sh and helper.mjs place the socket where the shared socket path says', () => {
  const install = readFileSync(join(HERE, '..', 'install.sh'), 'utf8')
  const installedUnder = dirname(dirname(contract.socketUnderHome))

  assert.match(install, new RegExp(`^TARGET="\\$HOME/${installedUnder.replaceAll('.', '\\.')}"$`, 'm'))
  assert.match(install, /mkdir -p "\$TARGET\/state" "\$TARGET\/run"/)

  const source = readFileSync(join(HERE, '..', 'helper.mjs'), 'utf8')
  assert.equal(contract.socketUnderHome, `${installedUnder}/run/helper.sock`)
  assert.match(source, /const RUN = process\.env\.CODEX_CU_RUN_DIR \?\? join\(HERE, 'run'\)/)
  assert.match(source, /const SOCKET = join\(RUN, 'helper\.sock'\)/)
})
