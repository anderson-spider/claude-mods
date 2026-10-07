import assert from 'node:assert/strict'
import { test } from 'node:test'

import { McpStdioClient } from '../lib/mcp-client.mjs'
import { FAKE } from './support.mjs'

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

