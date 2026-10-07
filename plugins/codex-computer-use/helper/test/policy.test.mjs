import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { Approvals, answerFor, parseRequest } from '../lib/approvals.mjs'
import { removeCodexApproval } from '../lib/codex-approvals.mjs'
import { namedApps, usedApp } from '../lib/apps.mjs'
import { isEntryCall } from '../lib/hub.mjs'
import { Owners } from '../lib/owners.mjs'
import { temp } from './support.mjs'

test('approval policy: deny beats everything, auto-approve starts off, callers are separate', () => {
  const file = join(temp(), 'a.json')
  const approvals = new Approvals(file)

  assert.equal(approvals.settings.autoApprove, false)
  assert.equal(approvals.decide('s1', 'com.x'), 'ask')
  approvals.record('s1', 'com.x', 'session')
  assert.equal(approvals.decide('s1', 'com.x'), 'session')
  assert.equal(approvals.decide('s2', 'com.x'), 'ask')
  approvals.setAutoApprove(true)
  assert.equal(approvals.decide('s2', 'com.x'), 'auto')
  approvals.record('s2', 'com.x', 'deny')
  assert.equal(approvals.decide('s2', 'com.x'), 'deny')
  approvals.record('s3', 'com.y', 'always')
  assert.equal(new Approvals(file).decide('other', 'com.y'), 'always')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { autoApprove: true, always: ['com.y'] })
  approvals.forget('s1')
  approvals.setAutoApprove(false)
  assert.equal(approvals.decide('s1', 'com.x'), 'ask')

  const request = parseRequest({ _meta: { connector_id: 'computer-use', persist: ['session'], tool_params: { app: 'com.z' } } })
  assert.equal(request.canAlways, false)
  assert.deepEqual(answerFor('always', request)._meta, { persist: 'session' })
  assert.deepEqual(answerFor('ask', request), { action: 'decline' })
  assert.equal(parseRequest({ message: 'record audio?', _meta: { connector_id: 'computer-use' } }).kind, 'other')
})
test('code scanning finds named apps and the used app; entry calls are recognised', () => {
  assert.deepEqual(namedApps('let a = await cua.getApp("Calculator"); const b = await cua.getApp(\'TextEdit\')'), ['Calculator', 'TextEdit'])
  assert.deepEqual(namedApps('cua.getApp(name)'), [])
  assert.equal(usedApp({ _meta: { 'codex/toolSurface': { app: { kind: 'appId', appId: 'com.apple.calculator' } } } }), 'com.apple.calculator')
  assert.equal(isEntryCall('await cua.getState();'), true)
  assert.equal(isEntryCall('// open it\nlet app = await cua.getApp("Calculator");'), true)
  assert.equal(isEntryCall('await app.typeText("1")'), false)

  const owners = new Owners()
  assert.deepEqual(owners.claim('com.a', 's1'), { ok: true })
  assert.deepEqual(owners.claim('com.a', 's2'), { ok: false, owner: 's1' })
  owners.release('s1')
  assert.deepEqual(owners.claim('com.a', 's2'), { ok: true })
})

test('removeCodexApproval takes out only that app, keeps the rest and the layout, and refuses an unknown shape', () => {
  const dir = temp()
  const file = join(dir, 'ComputerUseAppApprovals.json')
  writeFileSync(file, JSON.stringify({ approvedBundleIdentifiers: ['com.a', 'com.fake.Grapher', 'com.b'], other: 1 }, null, 2), { mode: 0o644 })

  assert.equal(removeCodexApproval('com.fake.Grapher', file), 'removed')
  const text = readFileSync(file, 'utf8')
  assert.deepEqual(JSON.parse(text), { approvedBundleIdentifiers: ['com.a', 'com.b'], other: 1 })
  assert.equal(text.endsWith('\n'), false)
  assert.match(text, /\n  "approvedBundleIdentifiers"/)
  assert.equal(removeCodexApproval('com.fake.Grapher', file), 'absent')
  assert.equal(removeCodexApproval('com.x', join(dir, 'none.json')), 'missing')

  const odd = join(dir, 'odd.json')
  writeFileSync(odd, '{"apps":[]}')
  assert.throws(() => removeCodexApproval('com.x', odd), /left untouched/)
  assert.equal(readFileSync(odd, 'utf8'), '{"apps":[]}')
})

