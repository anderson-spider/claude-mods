import { expect, test } from 'claude-code/testing'
import {
  HEADER,
  MARK,
  checkEnv,
  isLoopbackHttp,
  masked,
  pickerRows,
  planInstall,
  planUninstall,
  maskedSettings,
  readStatusReply,
  settingsRefusal,
} from '../install/settings.mjs'
import type { SettingsObject } from '../install/settings.mjs'
import * as status from '../hooks/status'

const ENV = {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:41234',
  ANTHROPIC_CUSTOM_HEADERS: 'X-Ccmproxy-Token: s3cret-value',
  ENABLE_TOOL_SEARCH: 'true',
}
const refusal = (message: string) => JSON.stringify({ type: 'error', error: { type: 'permission_error', message } })
const MODELS = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: 'Codex, high reasoning' },
  { id: 'gpt-6-mini', label: '', description: '' },
]

/** Install, then remove the current owned entries. */
function roundTrip(original: SettingsObject) {
  const installed = ok(planInstall(original, ENV, MODELS))
  const removed = planUninstall(installed.settings)
  if (removed.error !== undefined) throw new Error(removed.error)
  return { installed, removed: removed.settings }
}

const ok = (plan: ReturnType<typeof planInstall>) => {
  if (plan.error !== undefined) throw new Error(plan.error)
  return plan
}

test('a fresh install writes the three variables and marked rows, and uninstall leaves {}', () => {
  const { installed, removed } = roundTrip({})
  expect(installed.settings).toEqual({
    env: ENV,
    modelPicker: { options: [
      { model: 'gpt-6-astra', label: 'GPT-6 Astra', description: `Codex, high reasoning ${MARK}` },
      { model: 'gpt-6-mini', label: 'gpt-6-mini', description: MARK },
    ] },
  })
  expect(removed).toEqual({})
})

test('precheck accepts no URL or the configured URL, never a different URL or a lost config', () => {
  expect(settingsRefusal({}, undefined)).toBe(undefined)
  expect(settingsRefusal({ env: { ANTHROPIC_BASE_URL: `${ENV.ANTHROPIC_BASE_URL}/` } }, ENV.ANTHROPIC_BASE_URL)).toBe(undefined)
  for (const proxyUrl of [undefined, 'http://127.0.0.1:50000', 'https://gateway.example.com']) {
    const settings = { env: { ANTHROPIC_BASE_URL: ENV.ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS: ENV.ANTHROPIC_CUSTOM_HEADERS } }
    expect(settingsRefusal(settings, proxyUrl)).toContain('uninstall first')
  }
})

test('behavesAs is kept only when a non-empty string and rows stay marked', () => {
  expect(pickerRows([
    { id: 'a', label: 'A', description: 'Codex', behavesAs: 'claude-opus-4-8' },
    { id: 'b', behavesAs: '' }, { id: 'c', behavesAs: 7 },
  ]).rows).toEqual([
    { model: 'a', label: 'A', description: `Codex ${MARK}`, behavesAs: 'claude-opus-4-8' },
    { model: 'b', label: 'b', description: MARK }, { model: 'c', label: 'c', description: MARK },
  ])
})

test('unrelated settings stay, but tool search is removed by name rather than restored', () => {
  const original: SettingsObject = {
    model: 'opus',
    env: { KEEP: '1', ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue\nX-Trace: on', ENABLE_TOOL_SEARCH: 'false' },
    modelPicker: { replaceBuiltInOptions: false, options: [{ model: 'claude-opus-4-8', label: 'Opus' }] },
    pluginConfigs: { 'crew@spider-claude-mods': { options: { jevKey: '' } } },
  }
  const before = JSON.stringify(original)
  const { installed, removed } = roundTrip(original)
  expect((installed.settings.env as Record<string, string>).ENABLE_TOOL_SEARCH).toBe('true')
  expect(removed).toEqual({ ...original, env: { KEEP: '1', ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue\nX-Trace: on' } })
  expect(JSON.stringify(original)).toBe(before)
  for (const value of ['true', 'false', false, 7, null]) {
    expect(planUninstall({ env: { ENABLE_TOOL_SEARCH: value } }).settings).toEqual({})
  }
})

test('reinstall is idempotent and a changed port requires uninstall first', () => {
  const first = ok(planInstall({}, ENV, MODELS))
  expect(ok(planInstall(first.settings, ENV, MODELS)).settings).toEqual(first.settings)
  const moved = { ...ENV, ANTHROPIC_BASE_URL: 'http://127.0.0.1:50000' }
  expect(planInstall(first.settings, moved, MODELS).error).toContain('uninstall first')
  expect(ok(planInstall(planUninstall(first.settings).settings, moved, MODELS)).settings.env).toEqual(moved)
})

test('a row the person added for the same id stays and gets no marked twin', () => {
  const mine = { model: 'gpt-6-astra', label: 'Mine' }
  const { installed, removed } = roundTrip({ modelPicker: { options: [mine] } })
  const rows = (installed.settings.modelPicker as { options: { model: string }[] }).options
  expect(rows.map(row => row.model)).toEqual(['gpt-6-astra', 'gpt-6-mini'])
  expect(rows[0]).toEqual(mine)
  expect(removed).toEqual({ modelPicker: { options: [mine] } })
})

test('uninstall removes only a loopback HTTP URL that carried our header', () => {
  for (const url of ['http://127.0.0.1:9999', 'http://localhost:3/', 'http://[::1]:9']) {
    expect(planUninstall({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_CUSTOM_HEADERS: 'x-ccmproxy-token: old' } }).settings).toEqual({})
    expect(planUninstall({ env: { ANTHROPIC_BASE_URL: url } }).settings).toEqual({ env: { ANTHROPIC_BASE_URL: url } })
  }
  for (const url of ['https://gateway.example.com', 'https://127.0.0.1:3', 'http://10.0.0.1:3', 'http://127.0.0.1:3/v1']) {
    expect(planUninstall({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_CUSTOM_HEADERS: ENV.ANTHROPIC_CUSTOM_HEADERS } }).settings).toEqual({ env: { ANTHROPIC_BASE_URL: url } })
  }
})

test('header replacement and removal keep unrelated lines and remove every owned line', () => {
  const headers = 'X-Team: blue\nx-ccmproxy-token: old\n  X-Ccmproxy-Token : another\nX-Trace: on'
  const installed = ok(planInstall({ env: { ANTHROPIC_CUSTOM_HEADERS: headers } }, ENV, MODELS))
  expect((installed.settings.env as Record<string, string>).ANTHROPIC_CUSTOM_HEADERS).toBe(`X-Team: blue\nX-Trace: on\n${ENV.ANTHROPIC_CUSTOM_HEADERS}`)
  expect(planUninstall({ env: { ANTHROPIC_CUSTOM_HEADERS: headers } }).settings).toEqual({ env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue\nX-Trace: on' } })
})

test('empty owned keys and containers drop deterministically, other picker keys and unmarked rows stay', () => {
  expect(planUninstall({ env: { ANTHROPIC_CUSTOM_HEADERS: '' }, modelPicker: { options: [] } }).settings).toEqual({})
  const settings = { modelPicker: { replaceBuiltInOptions: false, options: [null, 'x', { model: 'a', description: `not ${MARK} ours` }, { model: 'b', description: MARK }] } }
  expect(planUninstall(settings).settings).toEqual({ modelPicker: { replaceBuiltInOptions: false, options: settings.modelPicker.options.slice(0, -1) } })
})

test('malformed settings are refused by both transformations', () => {
  for (const [settings, message] of [
    [[], 'JSON object'], [{ env: 'x' }, '"env"'], [{ modelPicker: null }, '"modelPicker"'],
    [{ modelPicker: { options: {} } }, 'modelPicker.options'], [{ env: { ANTHROPIC_CUSTOM_HEADERS: 3 } }, 'ANTHROPIC_CUSTOM_HEADERS'],
  ] as const) {
    expect(planInstall(settings, ENV, MODELS).error).toContain(message)
    expect(planUninstall(settings).error).toContain(message)
  }
})

test('maskedSettings hides every token value without mutating the input', () => {
  const settings = { env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue\nx-ccmproxy-token: old\nX-Ccmproxy-Token:  new ' }, model: 'opus' }
  expect(maskedSettings(settings)).toEqual({ env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue\nx-ccmproxy-token: <secret>\nX-Ccmproxy-Token: <secret>' }, model: 'opus' })
  expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toContain('old')
  expect(maskedSettings({ env: {} })).toEqual({ env: {} })
})

test('the proxy environment must be loopback, one header line and tool search', () => {
  expect(checkEnv(ENV)).toBe(undefined)
  expect(checkEnv({ ...ENV, ANTHROPIC_BASE_URL: 'http://10.0.0.1:1' })).toContain('loopback')
  expect(checkEnv({ ...ENV, ANTHROPIC_CUSTOM_HEADERS: 'X-Ccmproxy-Token: a\nX-Other: b' })).toContain(HEADER)
  expect(checkEnv({ ...ENV, ANTHROPIC_CUSTOM_HEADERS: 'X-Ccmproxy-Token:' })).toContain(HEADER)
  expect(checkEnv({ ...ENV, ENABLE_TOOL_SEARCH: 'false' })).toContain('tool search')
  expect(planInstall({}, { ...ENV, ANTHROPIC_BASE_URL: 'https://x' }, MODELS).error).toContain('loopback')
})

test('loopback means plain http on 127/8, ::1 or localhost, with no path', () => {
  for (const url of ['http://127.0.0.1:1', 'http://127.1.2.3:8080/', 'http://[::1]:9', 'http://localhost:3']) {
    expect(isLoopbackHttp(url), url).toBe(true)
  }
  for (const url of ['https://127.0.0.1:1', 'http://127.0.0.1.evil.com', 'http://127.0.0.1:1/v1', 'http://10.0.0.1', 3]) {
    expect(isLoopbackHttp(url), String(url)).toBe(false)
  }
})

test('the model list needs ids; duplicates are dropped', () => {
  expect(pickerRows({}).error).toContain('array')
  expect(pickerRows([{ label: 'x' }]).error).toContain('no id')
  expect(pickerRows([{ id: 'a' }, { id: 'a' }]).rows).toHaveLength(1)
})

test('the status reply is ok only when it names ccmproxy', () => {
  expect(readStatusReply(200, '{"service":"ccmproxy","version":"0.2.0","codexLogin":true,"models":["a",1]}')).toEqual({
    kind: 'ok',
    version: '0.2.0',
    codexLogin: true,
    models: ['a'],
  })
  expect(readStatusReply(403, refusal('ccmproxy: missing or wrong X-Ccmproxy-Token'))).toEqual({ kind: 'forbidden' })
  expect(readStatusReply(403, refusal('ccmproxy: unexpected Host header'))).toEqual({ kind: 'host' })
  expect(readStatusReply(200, '{"service":"metro"}').kind).toBe('foreign')
  expect(readStatusReply(200, '<html>').kind).toBe('foreign')
  expect(readStatusReply(404, '')).toEqual({ kind: 'foreign', reason: 'HTTP 404' })
})

test('a 403 not in ccmproxy\'s error shape is not ccmproxy', () => {
  const other = { kind: 'foreign', reason: 'HTTP 403 not from ccmproxy' }
  expect(readStatusReply(403, 'ccmproxy: forbidden')).toEqual(other)
  expect(readStatusReply(403, '')).toEqual(other)
  expect(readStatusReply(403, refusal('forbidden'))).toEqual(other)
  expect(readStatusReply(403, JSON.stringify({ type: 'error', error: { type: 'auth_error', message: 'ccmproxy: x' } }))).toEqual(other)
  expect(readStatusReply(403, JSON.stringify({ error: { type: 'permission_error', message: 'ccmproxy: x' } }))).toEqual(other)
})

test('masked hides every occurrence of the secret', () => {
  expect(masked('a s3 b s3', 's3')).toBe('a <secret> b <secret>')
  expect(masked('a', '')).toBe('a')
})

test('the install scripts and the hooks agree on the header and the row mark', () => {
  expect(HEADER).toBe(status.HEADER)
  expect(MARK).toBe(status.MARK)
})
