import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Approvals, answerFor, parseRequest } from '../lib/approvals.mjs'
import { removeCodexApproval } from '../lib/codex-approvals.mjs'
import { namedApps, usedApp } from '../lib/apps.mjs'
import { compareVersions, newestConfig, pickNewest, serverEnv } from '../lib/config.mjs'
import { Hub, isEntryCall } from '../lib/hub.mjs'
import { McpStdioClient } from '../lib/mcp-client.mjs'
import { Owners } from '../lib/owners.mjs'
import { handler } from '../helper.mjs'

const FAKE = fileURLToPath(new URL('./fake-server.mjs', import.meta.url))
const temp = () => mkdtempSync(join(tmpdir(), 'codex-cu-'))

const hubWith = (approved = 'Calculator', extra = {}) => {
  const clients = []
  const hub = new Hub({
    approvals: new Approvals(join(temp(), 'approvals.json')),
    // Never the real ComputerUseAppApprovals.json.
    codexApprovals: join(temp(), 'codex-approvals.json'),
    resolve: async name => `com.fake.${name}`,
    createClient: (_caller, onElicit) => {
      const client = new McpStdioClient({
        command: process.execPath,
        args: [FAKE],
        env: { ...process.env, FAKE_APPROVED: approved },
        onElicit,
      })
      clients.push(client)

      return client
    },
    ...extra,
  })

  return { hub, clients }
}

const textOf = reply => reply.content?.map(block => block.text).join('\n')

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

test('mcp client initializes, keeps the JS session between calls and reports a dead server clearly', async () => {
  const client = new McpStdioClient({ command: process.execPath, args: [FAKE] })
  const init = await client.start()
  assert.equal(init.serverInfo.name, 'fake')
  await client.callTool('js', { code: 'set n=25' })
  const got = await client.callTool('js', { code: 'get n' })
  assert.equal(got.content[0].text, '25')
  client.close()
  await assert.rejects(client.callTool('js', { code: 'get n' }), /closed/)

  const broken = new McpStdioClient({ command: '/nonexistent/node', args: [] })
  await assert.rejects(broken.start(), /could not start|exited/)
})

test('hub: first call must be an entry call, state survives calls, callers are isolated', async () => {
  const { hub } = hubWith()

  try {
    const refused = await hub.call('s1', { code: 'set n=1' })
    assert.equal(refused.status, 'error')
    assert.match(refused.message, /entry call/)

    assert.equal((await hub.call('s1', { code: 'await cua.getState();' })).status, 'ok')
    await hub.call('s1', { code: 'set n=25' })
    assert.equal(textOf(await hub.call('s1', { code: 'get n' })), '25')

    await hub.call('s1/agent-a', { code: 'await cua.getState();' })
    assert.equal(textOf(await hub.call('s1/agent-a', { code: 'get n' })), 'undefined')
  } finally {
    hub.close()
  }
})

test('hub: calls of one caller run one at a time, in order', async () => {
  const { hub } = hubWith()

  try {
    await hub.call('s1', { code: 'await cua.getState();' })
    const replies = await Promise.all(['set n=1', 'set n=2', 'get n'].map(code => hub.call('s1', { code })))
    assert.equal(textOf(replies[2]), '2')
  } finally {
    hub.close()
  }
})

test('hub: an unapproved app asks first, a denial is kept, and a session approval is per caller', async () => {
  const { hub } = hubWith('Calculator')

  try {
    const code = 'let app = await cua.getApp("TextEdit");'
    const asked = await hub.call('s1', { code })
    assert.equal(asked.status, 'needs_approval')
    assert.deepEqual(
      { bundleId: asked.app.bundleId, displayName: asked.app.displayName, canAlways: asked.app.canAlways },
      { bundleId: 'com.fake.TextEdit', displayName: 'TextEdit', canAlways: true },
    )

    hub.approve('s1', 'com.fake.TextEdit', 'session')
    const allowed = await hub.call('s1', { code })
    assert.equal(allowed.status, 'ok')
    assert.equal(textOf(await hub.call('s1', { code: 'get lastPersist' })), 'session')

    // Another caller is asked again, and the app is busy for it while s1 owns it.
    const other = await hub.call('s2', { code })
    assert.equal(other.status, 'busy')
    assert.equal(other.owner, 's1')

    hub.release('s1')
    const after = await hub.call('s2', { code })
    assert.equal(after.status, 'needs_approval')

    hub.approve('s2', 'com.fake.TextEdit', 'deny')
    const denied = await hub.call('s2', { code })
    assert.equal(denied.status, 'denied')
  } finally {
    hub.close()
  }
})

test('hub: auto-approve answers only when switched on; always is persisted for the server', async () => {
  const { hub } = hubWith('')

  try {
    hub.approvals.setAutoApprove(true)
    assert.equal((await hub.call('s1', { code: 'let a = await cua.getApp("Notepad");' })).status, 'ok')
    hub.approvals.setAutoApprove(false)
    assert.equal((await hub.call('s2', { code: 'let a = await cua.getApp("Paint");' })).status, 'needs_approval')
    hub.approve('s2', 'com.fake.Paint', 'always')
    await hub.call('s2', { code: 'let a = await cua.getApp("Paint");' })
    assert.equal(textOf(await hub.call('s2', { code: 'get lastPersist' })), 'always')
  } finally {
    hub.close()
  }
})

test('hub: reset and idle expiry release apps and start a fresh session', async () => {
  let clock = 0
  const { hub } = hubWith('Calculator', { now: () => clock, idleMs: 1000 })

  try {
    await hub.call('s1', { code: 'let app = await cua.getApp("Calculator");' })
    assert.equal(hub.owners.ownerOf('com.fake.Calculator'), 's1')
    await hub.reset('s1')
    assert.equal(hub.owners.ownerOf('com.fake.Calculator'), undefined)
    assert.equal((await hub.call('s1', { code: 'get n' })).status, 'error')

    await hub.call('s2', { code: 'let app = await cua.getApp("Calculator");' })
    clock = 5000
    hub.sweep()
    assert.equal(hub.owners.ownerOf('com.fake.Calculator'), undefined)
    assert.equal(hub.status().callers.length, 0)
  } finally {
    hub.close()
  }
})

test('hub: an app lease lapses 2 minutes (here 1 s) after its holder\'s last call', async () => {
  let clock = 0
  const { hub } = hubWith('Calculator', { now: () => clock, leaseMs: 1000 })
  const code = 'let app = await cua.getApp("Calculator");'

  try {
    assert.equal((await hub.call('s1', { code })).status, 'ok')
    clock = 500
    const busy = await hub.call('s2', { code })
    assert.equal(busy.status, 'busy')
    assert.equal(busy.owner, 's1')
    assert.equal(busy.idleSeconds, 1)

    clock = 2000
    assert.equal((await hub.call('s2', { code })).status, 'ok')
    assert.equal(hub.owners.ownerOf('com.fake.Calculator'), 's2')
    assert.equal((await hub.call('s1', { code })).status, 'busy')
  } finally {
    hub.close()
  }
})

test('hub: at most maxSessions run; the quietest idle one makes room, and none is stopped mid-call', async () => {
  let clock = 0
  const { hub } = hubWith('Calculator', { now: () => clock, maxSessions: 2 })
  const entry = { code: 'await cua.getState();' }

  try {
    await hub.call('s1', entry)
    clock = 10
    await hub.call('s2', entry)
    clock = 20
    assert.equal((await hub.call('s3', entry)).status, 'ok')
    assert.deepEqual(hub.status().callers.map(one => one.caller).sort(), ['s2', 's3'])

    const slow = [hub.call('s2', { code: 'sleep 300' }), hub.call('s3', { code: 'sleep 300' })]
    await new Promise(resolve => setTimeout(resolve, 50))
    const full = await hub.call('s4', entry)
    assert.equal(full.status, 'full')
    await Promise.all(slow)
  } finally {
    hub.close()
  }
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

test('hub.forget removes "always" from the helper and from Codex, so the app asks again', async () => {
  const codex = join(temp(), 'codex.json')
  writeFileSync(codex, JSON.stringify({ approvedBundleIdentifiers: ['com.fake.Calculator', 'com.fake.Grapher'] }, null, 2))
  const { hub } = hubWith('Calculator', { codexApprovals: codex })
  const code = 'let g = await cua.getApp("Grapher");'

  try {
    hub.approve('s1', 'com.fake.Grapher', 'always')
    assert.equal((await hub.call('s1', { code })).status, 'ok')

    const forgotten = await hub.forget('Grapher')
    assert.deepEqual(forgotten, { status: 'ok', bundleId: 'com.fake.Grapher', helper: true, codex: 'removed' })
    assert.deepEqual(JSON.parse(readFileSync(codex, 'utf8')).approvedBundleIdentifiers, ['com.fake.Calculator'])
    assert.equal(hub.approvals.decide('s1', 'com.fake.Grapher'), 'ask')

    // s1's running session was restarted: it starts over with an entry call, and the app asks.
    const again = await hub.call('s1', { code })
    assert.equal(again.status, 'needs_approval')

    assert.deepEqual(await hub.forget('Grapher'), { status: 'ok', bundleId: 'com.fake.Grapher', helper: false, codex: 'absent' })
  } finally {
    hub.close()
  }
})

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
