import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BASE = 'http://127.0.0.1:41234'
const SECRET = 's3cret-value'
const HOME = '/Users/jane'
const CONFIG = `${HOME}/.claude/codex-models/home/config.json`
const STATUS = JSON.stringify({ service: 'ccmproxy', version: '0.2.0', codexLogin: true, models: ['gpt-6-astra'] })

type Reply = { status: number; text: string } | 'refused' | 'hang'

/** A host with the session's environment, the user settings, the config file and a fake proxy behind `http.fetch`. */
function world(
  on: On,
  opts: {
    env?: Record<string, string>
    reply?: Reply
    files?: Record<string, string>
    settings?: Record<string, unknown> | 'fail'
    fsFail?: boolean
  } = {},
) {
  const seen = { fetches: [] as { url: string; headers: Record<string, string> }[], transcript: [] as string[], logs: [] as string[], toasts: [] as string[] }
  const clock = mock.clock(on)
  mock.env(on, {
    HOME,
    ...(opts.env ?? { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_CUSTOM_HEADERS: `X-Team: blue\nX-Ccmproxy-Token: ${SECRET}` }),
  })
  on('http.fetch', async (_$, e) => {
    seen.fetches.push({ url: e.url, headers: (e.init?.headers ?? {}) as Record<string, string> })
    const reply = opts.reply ?? { status: 200, text: STATUS }
    if (reply === 'refused') throw new Error('connect ECONNREFUSED')
    if (reply === 'hang') return new Promise<never>(() => {})
    return { value: { status: reply.status, ok: reply.status < 300, headers: {}, text: reply.text } }
  })
  on('fs.read', async (_$, e) => {
    if (opts.fsFail) throw new Error('EACCES')
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"version":"0.2.0"}' }
    const text = opts.files?.[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('settings.read', async () => {
    if (opts.settings === 'fail') throw new Error('unreadable')
    return { value: opts.settings ?? {} } as never
  })
  on('ui.log', async (_$, e) => {
    seen.logs.push(e.text)
    if (e.to === 'transcript') seen.transcript.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.toast', async (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return { seen, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
const status = ($: Engine) => $.command.run({ command: 'codex-models:status', args: '', origin: { kind: 'composer' } } as never)

const everything = (seen: ReturnType<typeof world>['seen']) => [...seen.logs, ...seen.toasts].join('\n')

test('session start checks the proxy with the session secret and stays quiet when it is healthy', async ($, on) => {
  const { seen } = world(on)

  const out = await start($)

  expect(out.cwd).toBe('/proj')
  expect(seen.fetches).toEqual([{ url: `${BASE}/__ccmproxy/status`, headers: { 'X-Ccmproxy-Token': SECRET } }])
  expect(seen.transcript).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(seen.logs).toContain('status check at start: ok')
})

test('session start sends nothing without a loopback base URL', async ($, on) => {
  const { seen } = world(on, { env: {} })

  await start($)

  expect(seen.fetches).toEqual([])
  expect(seen.transcript).toEqual([])
})

test('session start sends nothing for a base URL off loopback', async ($, on) => {
  const { seen } = world(on, {
    env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com', ANTHROPIC_CUSTOM_HEADERS: `X-Ccmproxy-Token: ${SECRET}` },
  })

  await start($)

  expect(seen.fetches).toEqual([])
})

test('a proxy that is down gets a notice with the way back', async ($, on) => {
  const { seen } = world(on, { reply: 'refused' })

  await start($)

  expect(seen.transcript).toHaveLength(1)
  expect(seen.transcript[0]).toContain(`the proxy at ${BASE} is down`)
  expect(seen.transcript[0]).toContain('~/.claude/codex-models/uninstall.sh')
  expect(seen.toasts).toEqual(seen.transcript)
  expect(everything(seen)).not.toContain(SECRET)
})

test('a 403 is named as a wrong secret', async ($, on) => {
  const { seen } = world(on, { reply: { status: 403, text: 'ccmproxy: forbidden' } })

  await start($)

  expect(seen.transcript[0]).toContain("refused this session's secret (403)")
  expect(everything(seen)).not.toContain(SECRET)
})

test('another server on the port is named as not ccmproxy', async ($, on) => {
  const { seen } = world(on, { reply: { status: 200, text: '{"service":"metro"}' } })

  await start($)

  expect(seen.transcript[0]).toContain('something other than ccmproxy answers')
  expect(seen.transcript[0]).not.toContain('metro')
})

test('a proxy that does not answer within 1.5 s times out and the start goes on', async ($, on) => {
  const { seen, clock } = world(on, { reply: 'hang' })

  const pending = start($)
  await clock.advance(1_499)
  expect(seen.transcript).toEqual([])
  await clock.advance(1)
  const out = await pending

  expect(out.cwd).toBe('/proj')
  expect(seen.transcript[0]).toContain('did not answer within 1.5 s')
})

test('a stale binary is named with the install script to rerun', async ($, on) => {
  const { seen } = world(on, { reply: { status: 200, text: JSON.stringify({ service: 'ccmproxy', version: '0.1.0', codexLogin: true }) } })

  await start($)

  expect(seen.transcript[0]).toContain('runs 0.1.0 and the plugin is 0.2.0')
  expect(seen.transcript[0]).toContain('/install.sh')
})

test('no secret header is named, and nothing is sent', async ($, on) => {
  const { seen } = world(on, { env: { ANTHROPIC_BASE_URL: BASE } })

  await start($)

  expect(seen.fetches).toEqual([])
  expect(seen.transcript[0]).toContain('no X-Ccmproxy-Token header is set')
})

test('a failing file system does not stop the start', async ($, on) => {
  const { seen } = world(on, { fsFail: true, reply: { status: 403, text: '' } })

  const out = await start($)

  expect(out.cwd).toBe('/proj')
  expect(seen.transcript[0]).toContain('403')
})

test('/codex-models:status reports the proxy and the settings without the secret', async ($, on) => {
  const { seen } = world(on, {
    files: { [CONFIG]: JSON.stringify({ listen_http: '127.0.0.1:41234', auth_token: SECRET }) },
    settings: {
      env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_CUSTOM_HEADERS: `X-Ccmproxy-Token: ${SECRET}`, ENABLE_TOOL_SEARCH: 'true' },
      modelPicker: { options: [{ model: 'gpt-6-astra', label: 'Astra', description: 'Codex (codex-models)' }] },
    },
  })

  const out = await status($)

  expect(out.text).toContain('codex-models 0.2.0')
  expect(out.text).toContain('Proxy: ccmproxy 0.2.0 at http://127.0.0.1:41234 (matches the plugin)')
  expect(out.text).toContain('Codex login: signed in')
  expect(out.text).toContain('Models: gpt-6-astra')
  expect(out.text).toContain('present, matches the proxy config (secret not shown)')
  expect(out.text).toContain('/model rows: 1 (gpt-6-astra)')
  expect(out.text).not.toContain(SECRET)
  expect(seen.fetches).toHaveLength(1)
})

test('/codex-models:status checks the config address when the session does not use the proxy', async ($, on) => {
  const { seen } = world(on, {
    env: {},
    files: { [CONFIG]: JSON.stringify({ listen_http: '127.0.0.1:5555', auth_token: SECRET }) },
    reply: 'refused',
  })

  const out = await status($)

  expect(seen.fetches[0]?.url).toBe('http://127.0.0.1:5555/__ccmproxy/status')
  expect(out.text).toContain('Proxy: down at http://127.0.0.1:5555')
  expect(out.text).toContain('ANTHROPIC_BASE_URL: not set')
  expect(out.text).not.toContain(SECRET)
})

test('/codex-models:status says when nothing is installed, and when the settings cannot be read', async ($, on) => {
  const { seen } = world(on, { env: {}, settings: 'fail' })

  const out = await status($)

  expect(seen.fetches).toEqual([])
  expect(out.text).toContain('Proxy: not installed')
  expect(out.text).toContain('could not be read')
})
