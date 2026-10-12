import { expect, test } from 'claude-code/testing'
import {
  DEADLINE_MS,
  UNINSTALL,
  configOf,
  loopbackBase,
  noticeText,
  probe,
  readReply,
  reportText,
  settingsView,
  tokenOf,
  versionOf,
} from '../hooks/status'
import type { Probe, ProbeIo } from '../hooks/status'

const BASE = 'http://127.0.0.1:41234'
const SECRET = 's3cret-value'
const CTX = { base: BASE, pluginVersion: '0.2.0', pluginRoot: '/plugins/codex-models' }
const refusal = (message: string) => JSON.stringify({ type: 'error', error: { type: 'permission_error', message } })
const OK: Probe = { kind: 'ok', version: '0.2.0', codexLogin: true, models: ['gpt-6-astra'] }

/** A fake network and a timer the test fires by hand. */
function io(reply: () => Promise<{ status: number; text: string }>) {
  const sent: { url: string; headers: Record<string, string> }[] = []
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const host: ProbeIo = {
    fetch: (url, headers) => (sent.push({ url, headers }), reply()),
    timer: (ms, fn) => {
      const timer = { ms, fn, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  }
  return { host, sent, timers }
}

test('the base URL counts only as plain loopback http, trailing slash dropped', () => {
  expect(loopbackBase('http://127.0.0.1:41234/')).toBe(BASE)
  expect(loopbackBase('http://[::1]:9')).toBe('http://[::1]:9')
  expect(loopbackBase('https://api.anthropic.com')).toBe(undefined)
  expect(loopbackBase('http://127.0.0.1:1/v1')).toBe(undefined)
  expect(loopbackBase(undefined)).toBe(undefined)
})

test('the secret comes from its own header line, whatever the case and the other lines', () => {
  expect(tokenOf(`X-Team: blue\nx-ccmproxy-token:  ${SECRET} `)).toBe(SECRET)
  expect(tokenOf('X-Team: blue')).toBe(undefined)
  expect(tokenOf('X-Ccmproxy-Token:')).toBe(undefined)
  expect(tokenOf(undefined)).toBe(undefined)
})

test('the config gives the listen address and the secret, and nothing when malformed', () => {
  expect(configOf(JSON.stringify({ listen_http: '127.0.0.1:41234', auth_token: SECRET }))).toEqual({ base: BASE, token: SECRET })
  expect(configOf(JSON.stringify({ listen_http: '0.0.0.0:1', auth_token: '' }))).toEqual({})
  expect(configOf('not json')).toEqual({})
  expect(versionOf('{"version":"0.2.0"}')).toBe('0.2.0')
  expect(versionOf('{')).toBe('unknown')
})

test('the reply is read without quoting its body', () => {
  expect(readReply(200, JSON.stringify({ service: 'ccmproxy', version: '0.2.0', codexLogin: true, models: ['gpt-6-astra'] }))).toEqual(OK)
  expect(readReply(403, refusal('ccmproxy: missing or wrong X-Ccmproxy-Token'))).toEqual({ kind: 'forbidden' })
  expect(readReply(403, refusal('ccmproxy: unexpected Host header'))).toEqual({ kind: 'host' })
  expect(readReply(200, '{"service":"metro","token":"leak"}')).toEqual({ kind: 'foreign', reason: 'the answer does not name ccmproxy' })
  expect(readReply(502, 'leak')).toEqual({ kind: 'foreign', reason: 'HTTP 502' })
})

test('a 403 not in ccmproxy\'s error shape is not ccmproxy', () => {
  const other = { kind: 'foreign', reason: 'HTTP 403 not from ccmproxy' }
  expect(readReply(403, 'ccmproxy: forbidden')).toEqual(other)
  expect(readReply(403, '<html>Forbidden</html>')).toEqual(other)
  expect(readReply(403, refusal('Forbidden'))).toEqual(other)
  expect(readReply(403, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'ccmproxy: x' } }))).toEqual(other)
  expect(readReply(403, JSON.stringify([1]))).toEqual(other)
})

test('the probe sends the secret to the status path and cancels its deadline on an answer', async () => {
  const fake = io(async () => ({ status: 200, text: JSON.stringify({ service: 'ccmproxy', version: '0.2.0', codexLogin: true, models: [] }) }))

  const found = await probe(fake.host, BASE, SECRET)

  expect(found.kind).toBe('ok')
  expect(fake.sent).toEqual([{ url: `${BASE}/__ccmproxy/status`, headers: { 'X-Ccmproxy-Token': SECRET } }])
  expect(fake.timers[0]?.ms).toBe(DEADLINE_MS)
  expect(fake.timers[0]?.cancelled).toBe(true)
})

test('a refused connection is down, a silent one times out, and no secret sends nothing', async () => {
  expect(await probe(io(() => Promise.reject(new Error('ECONNREFUSED'))).host, BASE, SECRET)).toEqual({ kind: 'down' })

  const silent = io(() => new Promise(() => {}))
  const pending = probe(silent.host, BASE, SECRET)
  silent.timers[0]?.fn()
  expect(await pending).toEqual({ kind: 'timeout' })

  const none = io(async () => ({ status: 200, text: '' }))
  expect(await probe(none.host, BASE, undefined)).toEqual({ kind: 'no-secret' })
  expect(none.sent).toEqual([])
})

test('each case has its own notice and the way back; a healthy proxy has none', () => {
  const cases: [Probe, string][] = [
    [{ kind: 'down' }, 'is down'],
    [{ kind: 'timeout' }, 'did not answer within 1.5 s'],
    [{ kind: 'forbidden' }, 'refused this session\'s secret (403)'],
    [{ kind: 'host' }, 'refused the Host header (403)'],
    [{ kind: 'foreign', reason: 'HTTP 404' }, 'something other than ccmproxy answers'],
    [{ kind: 'no-secret' }, 'no X-Ccmproxy-Token header is set'],
  ]
  for (const [found, words] of cases) {
    const text = noticeText(found, CTX) ?? ''
    expect(text, found.kind).toContain(words)
    expect(text, found.kind).toContain(UNINSTALL)
    expect(text, found.kind).toContain(BASE)
  }
  expect(noticeText({ kind: 'forbidden' }, CTX)).toContain('sh /plugins/codex-models/install.sh')
  expect(noticeText(OK, CTX)).toBe(undefined)
})

test('a stale binary and a missing login get their own notices', () => {
  expect(noticeText({ ...OK, version: '0.1.0' }, CTX)).toContain('runs 0.1.0 and the plugin is 0.2.0')
  expect(noticeText({ ...OK, codexLogin: false }, CTX)).toContain('login codex')
})

test('the settings view finds the entries install wrote, without the secret in the report', () => {
  const view = settingsView({
    env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_CUSTOM_HEADERS: `X-Ccmproxy-Token: ${SECRET}`, ENABLE_TOOL_SEARCH: 'true' },
    modelPicker: { options: [{ model: 'gpt-6-astra', description: 'Codex (codex-models)' }, { model: 'mine', description: 'x' }] },
  })

  expect(view.rows).toEqual(['gpt-6-astra'])
  const text = reportText({ pluginVersion: '0.2.0', pluginRoot: '/p', base: BASE, probe: OK, configToken: SECRET, settings: view })
  expect(text).toContain('Proxy: ccmproxy 0.2.0 at http://127.0.0.1:41234 (matches the plugin)')
  expect(text).toContain('Codex login: signed in')
  expect(text).toContain('Models: gpt-6-astra')
  expect(text).toContain('X-Ccmproxy-Token header: present, matches the proxy config (secret not shown)')
  expect(text).toContain('ENABLE_TOOL_SEARCH: true')
  expect(text).toContain('/model rows: 1 (gpt-6-astra)')
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain('Next:')
})

test('the report names what is missing and what to do', () => {
  const none = reportText({ pluginVersion: '0.2.0', pluginRoot: '/p', settings: settingsView({}) })
  expect(none).toContain('Proxy: not installed')
  expect(none).toContain('ANTHROPIC_BASE_URL: not set')
  expect(none).toContain('X-Ccmproxy-Token header: missing')
  expect(none).toContain('/model rows: none')

  const wrong = reportText({
    pluginVersion: '0.2.0',
    pluginRoot: '/p',
    base: BASE,
    probe: { kind: 'forbidden' },
    configToken: 'other',
    settings: settingsView({ env: { ANTHROPIC_CUSTOM_HEADERS: `X-Ccmproxy-Token: ${SECRET}` } }),
  })
  expect(wrong).toContain('refused the secret (403)')
  expect(wrong).toContain('differs from the proxy config')
  expect(wrong).toContain('Next: the proxy at')
  expect(wrong).not.toContain(SECRET)

  expect(reportText({ pluginVersion: '0.2.0', pluginRoot: '/p' })).toContain('could not be read')
  expect(reportText({ pluginVersion: '0.2.0', pluginRoot: '/p', base: BASE, probe: { kind: 'host' } })).toContain(
    'Proxy: http://127.0.0.1:41234 refused the Host header (403)',
  )
})
