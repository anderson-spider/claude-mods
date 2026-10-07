import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Approvals } from '../lib/approvals.mjs'
import { Hub } from '../lib/hub.mjs'
import { McpStdioClient } from '../lib/mcp-client.mjs'

export const FAKE = fileURLToPath(new URL('./fake-server.mjs', import.meta.url))
export const temp = () => mkdtempSync(join(tmpdir(), 'codex-cu-'))

export const hubWith = (approved = 'Calculator', extra = {}) => {
  const clients = []
  const hub = new Hub({
    approvals: new Approvals(join(temp(), 'approvals.json')),
    // Never the real ComputerUseAppApprovals.json.
    codexApprovals: join(temp(), 'codex-approvals.json'),
    resolve: async name => `com.fake.${name}`,
    createClient: onElicit => {
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
