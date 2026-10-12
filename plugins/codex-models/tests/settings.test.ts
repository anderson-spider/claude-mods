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
  readStatusReply,
} from '../install/settings.mjs'
import type { InstallState, SettingsObject } from '../install/settings.mjs'
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

/** Install, then uninstall with the state install returned. */
function roundTrip(original: SettingsObject) {
  const installed = planInstall(original, ENV, MODELS)
  if (installed.error !== undefined) throw new Error(installed.error)
  const removed = planUninstall(installed.settings, installed.state)
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
    modelPicker: {
      options: [
        { model: 'gpt-6-astra', label: 'GPT-6 Astra', description: `Codex, high reasoning ${MARK}` },
        { model: 'gpt-6-mini', label: 'gpt-6-mini', description: MARK },
      ],
    },
  })
  expect(installed.state.models).toEqual(['gpt-6-astra', 'gpt-6-mini'])
  expect(JSON.stringify(removed)).toBe('{}')
})

test('the state never holds a header value', () => {
  const { installed } = roundTrip({ env: { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer other-secret' } })

  expect(JSON.stringify(installed.state)).not.toContain('s3cret-value')
  expect(JSON.stringify(installed.state)).not.toContain('other-secret')
})

test('other env keys, header lines, picker settings and pluginConfigs are kept, and uninstall restores them exactly', () => {
  const original: SettingsObject = {
    model: 'opus',
    env: { USE_BUILTIN_RIPGREP: '0', ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue\nX-Trace: on', ENABLE_TOOL_SEARCH: 'false' },
    modelPicker: { replaceBuiltInOptions: false, options: [{ model: 'claude-opus-4-8', label: 'Opus (production)' }] },
    pluginConfigs: { 'crew@spider-claude-mods': { options: { nativeCodex: 'developer=gpt-6-astra' } } },
  }
  const { installed, removed } = roundTrip(original)
  const env = installed.settings.env as Record<string, string>
  const picker = installed.settings.modelPicker as { replaceBuiltInOptions: boolean; options: unknown[] }

  expect(env.USE_BUILTIN_RIPGREP).toBe('0')
  expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Team: blue\nX-Trace: on\nX-Ccmproxy-Token: s3cret-value')
  expect(env.ENABLE_TOOL_SEARCH).toBe('true')
  expect(picker.replaceBuiltInOptions).toBe(false)
  expect(picker.options).toHaveLength(3)
  expect(installed.settings.pluginConfigs).toEqual(original.pluginConfigs)
  // Byte-identical once formatted the same way: key order included.
  expect(JSON.stringify(removed)).toBe(JSON.stringify(original))
})

test('an existing X-Ccmproxy-Token line is replaced, not doubled', () => {
  const plan = ok(planInstall({ env: { ANTHROPIC_CUSTOM_HEADERS: 'x-ccmproxy-token: old\nX-Team: blue' } }, ENV, MODELS))

  expect((plan.settings.env as Record<string, string>).ANTHROPIC_CUSTOM_HEADERS).toBe('X-Team: blue\nX-Ccmproxy-Token: s3cret-value')
})

test('a base URL that is not ours is refused and named', () => {
  const plan = planInstall({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com' } }, ENV, MODELS)

  expect(plan.error).toContain('https://gateway.example.com')
  expect(plan.settings).toBe(undefined)
})

test('a second run changes nothing, keeps the first state, and uninstall still restores the original', () => {
  const original: SettingsObject = { env: { ENABLE_TOOL_SEARCH: 'false' }, modelPicker: { options: [] } }
  const first = ok(planInstall(original, ENV, MODELS))
  const second = ok(planInstall(first.settings, ENV, MODELS, first.state))

  expect(JSON.stringify(second.settings)).toBe(JSON.stringify(first.settings))
  expect(second.state).toEqual(first.state)
  const removed = planUninstall(second.settings, second.state)
  expect(JSON.stringify(removed.settings)).toBe(JSON.stringify(original))
})

test('a reinstall on a new port replaces the base URL the previous install wrote', () => {
  const first = ok(planInstall({}, ENV, MODELS))
  const moved = { ...ENV, ANTHROPIC_BASE_URL: 'http://127.0.0.1:50000' }
  const second = ok(planInstall(first.settings, moved, MODELS, first.state))

  expect((second.settings.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:50000')
  expect(JSON.stringify(planUninstall(second.settings, second.state).settings)).toBe('{}')
})

test('without a matching base URL in the settings, an old state is not trusted', () => {
  const stale: InstallState = {
    v: 1,
    baseUrl: 'http://127.0.0.1:1',
    envCreated: true,
    headersExisted: false,
    toolSearch: { present: false },
    pickerCreated: true,
    optionsCreated: true,
    models: [],
  }
  const plan = ok(planInstall({ env: { ENABLE_TOOL_SEARCH: '1' } }, ENV, MODELS, stale))

  expect(plan.state.envCreated).toBe(false)
  expect(plan.state.toolSearch).toEqual({ present: true, value: '1' })
})

test('a row the person added for the same id stays and gets no marked twin', () => {
  const mine = { model: 'gpt-6-astra', label: 'Mine' }
  const { installed, removed } = roundTrip({ modelPicker: { options: [mine] } })
  const options = (installed.settings.modelPicker as { options: { model: string }[] }).options

  expect(options.map(row => row.model)).toEqual(['gpt-6-astra', 'gpt-6-mini'])
  expect(options[0]).toEqual(mine)
  expect(installed.state.models).toEqual(['gpt-6-mini'])
  expect(removed).toEqual({ modelPicker: { options: [mine] } })
})

test('uninstall without a state takes out the base URL, the header and the rows, and leaves tool search', () => {
  const installed = ok(planInstall({ env: { KEEP: '1' } }, ENV, MODELS)).settings
  const removed = planUninstall(installed, undefined).settings

  expect(removed).toEqual({ env: { KEEP: '1', ENABLE_TOOL_SEARCH: 'true' }, modelPicker: { options: [] } })
})

test('uninstall without a state leaves a base URL that carries no header of ours', () => {
  const settings = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' } }

  expect(planUninstall(settings, undefined).settings).toEqual(settings)
})

test('uninstall leaves a base URL the person changed after install', () => {
  const first = ok(planInstall({}, ENV, MODELS))
  const changed = { ...first.settings, env: { ...(first.settings.env as object), ANTHROPIC_BASE_URL: 'https://gateway.example.com' } }
  const env = planUninstall(changed, first.state).settings?.env as Record<string, string>

  expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.com')
  expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(undefined)
})

test('malformed settings are refused rather than rewritten', () => {
  expect(planInstall([], ENV, MODELS).error).toContain('JSON object')
  expect(planInstall({ env: 'x' }, ENV, MODELS).error).toContain('"env"')
  expect(planInstall({ modelPicker: { options: {} } }, ENV, MODELS).error).toContain('modelPicker.options')
  expect(planInstall({ env: { ANTHROPIC_CUSTOM_HEADERS: 3 } }, ENV, MODELS).error).toContain('ANTHROPIC_CUSTOM_HEADERS')
  expect(planUninstall('x').error).toContain('JSON object')
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
