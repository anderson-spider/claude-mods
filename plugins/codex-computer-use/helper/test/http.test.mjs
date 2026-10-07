import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { request } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { handler } from '../helper.mjs'
import { hubWith, temp } from './support.mjs'

test('socket API routes calls, approvals, settings and rejects bad callers', async () => {
  const { hub } = hubWith()
  const socket = join(temp(), 'h.sock')
  const server = createServer(handler(hub))
  await new Promise(resolve => server.listen(socket, resolve))
  const post = (path, body) =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath: socket, path, method: 'POST' }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })

  try {
    assert.equal((await post('/call', { caller: '../x', code: 'x' })).code, 400)
    assert.equal((await post('/call', { caller: 's1', code: 'await cua.getState();' })).body.status, 'ok')
    assert.equal((await post('/settings', {})).body.settings.autoApprove, false)
    assert.equal((await post('/approve', { caller: 's1', bundleId: 'com.x', choice: 'maybe' })).code, 400)
    assert.equal((await post('/release', { caller: 's1' })).body.ended[0], 's1')
    const forgot = await post('/forget', { app: 'Grapher' })
    assert.equal(forgot.code, 200)
    assert.equal(forgot.body.bundleId, 'com.fake.Grapher')
    assert.equal((await post('/forget', { app: '' })).code, 400)
  } finally {
    server.close()
    hub.close()
  }
})

