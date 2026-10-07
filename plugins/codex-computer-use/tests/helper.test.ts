import { expect, test } from 'claude-code/testing'

import { post } from '../hooks/helper'

import { ran } from './helpers'

test('post speaks to the helper over its Unix socket and reports a missing helper as unreachable', async () => {
  const seen: { url: string; socketPath?: string }[] = []
  const run = async () => ran('')
  const reply = await post(
    { fetch: async (url, init) => (seen.push({ url, socketPath: init.socketPath }), Promise.reject(new Error('ECONNREFUSED'))), run },
    '/s.sock',
    '/call',
    { caller: 'x' },
  )

  expect(reply.status).toBe('unreachable')
  expect(seen).toEqual([{ url: 'http://codex-cu/call', socketPath: '/s.sock' }])

  const answered = await post({ fetch: async () => ({ status: 200, ok: true, headers: {}, text: '{"status":"ok","ended":[]}' }), run }, '/s.sock', '/release', {})
  expect(answered.status).toBe('ok')
})
