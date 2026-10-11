import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { statusReport } from '../hooks/presentation'
import { HELP } from '../hooks/prompts'
import { ran, world } from './helpers'

// Characterization of what /codex-cu answers for each command kind and which
// helper route it posts to (register.test.ts covers `forget <app>` and the
// effect of `on` and `off`).

const SOCKET = '/home/me/.claude/mcp/codex-cu/run/helper.sock'
const run = ($: Engine, args: string) => $.command.run({ command: 'codex-cu', args } as never)

test('/codex-cu on and off answer their own text', async ($, on) => {
  world(on)

  expect((await run($, 'off')).text).toBe('codex-cu off: Claude’s own desktop computer use is back; the Codex bridge refuses calls.')
  expect((await run($, 'on')).text).toBe('codex-cu on: desktop apps go through Codex computer use; Claude’s own computer use is blocked.')
})

test('/codex-cu auto-approve posts the setting and says which way it went', async ($, on) => {
  const posted = world(on)

  expect((await run($, 'auto-approve on')).text).toBe('codex-cu auto-approve on: apps are used without asking (organization and safety blocks still apply).')
  expect(posted.at(-1)).toEqual({ route: '/settings', body: { autoApprove: true }, socketPath: SOCKET })

  expect((await run($, 'auto-approve off')).text).toBe('codex-cu auto-approve off: a new app asks first.')
  expect(posted.at(-1)).toEqual({ route: '/settings', body: { autoApprove: false }, socketPath: SOCKET })
})

test('/codex-cu auto-approve says the helper could not be reached when its answer is not JSON', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', () => ({ value: ran('', 1) }))
  on('http.fetch', () => ({ value: { status: 502, ok: false, headers: {}, text: 'bad gateway' } }))

  expect((await run($, 'auto-approve on')).text).toBe(
    'codex-cu: could not reach the helper (the helper answered 502 with something that is not JSON: bad gateway).',
  )
})

test('/codex-cu forget releases this session and says its answers were dropped', async ($, on) => {
  const posted = world(on)

  expect((await run($, 'forget')).text).toBe('codex-cu: this session’s Codex sessions ended and its app answers were dropped.')
  expect(posted.at(-1)).toEqual({ route: '/release', body: { caller: 'sess-1' }, socketPath: SOCKET })
})

test('/codex-cu status asks the helper for its report and help is the fixed text', async ($, on) => {
  const posted = world(on)

  const status = await run($, 'status')
  expect(posted.at(-1)).toEqual({ route: '/status', body: {}, socketPath: SOCKET })
  expect(status.text).toBe(statusReport(true, { status: 'ok', ended: [] } as never))
  expect((await run($, '')).text).toBe(status.text)

  expect((await run($, 'help')).text).toBe(HELP)
  expect((await run($, 'auto-approve maybe')).text).toBe(HELP)
})
