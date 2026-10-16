import { expect, test } from 'claude-code/testing'
import { OFF_TEXT, checkKey, checkUrl, declaresOption, resolveAccess, type AccessIo } from '../hooks/access'

const KEY = '1|coolify-test-token'
const URL_OPTION = 'https://coolify.example.com'
const io = (sources: Partial<Record<'project' | 'local', { pluginConfigs?: unknown }>> = {}): AccessIo => ({
  settings: async (source) => sources[source],
})

test('checkKey tells an absent key from a malformed one', () => {
  expect(checkKey(undefined)).toEqual({ off: 'no-key' })
  expect(checkKey('  ')).toEqual({ off: 'no-key' })
  expect(checkKey(5)).toEqual({ off: 'bad-key' })
  expect(checkKey('a b')).toEqual({ off: 'bad-key' })
  expect(checkKey('x'.repeat(513))).toEqual({ off: 'bad-key' })
  expect(checkKey(` ${KEY} `)).toEqual({ key: KEY })
})

test('checkUrl turns an https origin into its API base', () => {
  expect(checkUrl(URL_OPTION)).toEqual({ base: 'https://coolify.example.com/api/v1' })
  expect(checkUrl(' https://coolify.example.com/ ')).toEqual({ base: 'https://coolify.example.com/api/v1' })
  expect(checkUrl('https://coolify.example.com/api/v1/')).toEqual({ base: 'https://coolify.example.com/api/v1' })
  expect(checkUrl('https://Coolify.Example.com:8443')).toEqual({ base: 'https://coolify.example.com:8443/api/v1' })
  expect(checkUrl('https://app.coolify.io')).toEqual({ base: 'https://app.coolify.io/api/v1' })
})

test('checkUrl refuses a missing url, plain http, credentials, another path, a query or a fragment', () => {
  expect(checkUrl(undefined)).toEqual({ off: 'no-url' })
  expect(checkUrl(' ')).toEqual({ off: 'no-url' })
  for (const bad of [
    5,
    'coolify.example.com',
    'http://coolify.example.com',
    'ftp://coolify.example.com',
    'https://user:pass@coolify.example.com',
    'https://user@coolify.example.com',
    'https://coolify.example.com/other',
    'https://coolify.example.com/api/v2',
    'https://coolify.example.com/?x=1',
    'https://coolify.example.com/?',
    'https://coolify.example.com/#x',
    'https://',
  ]) {
    expect(checkUrl(bad), String(bad)).toEqual({ off: 'bad-url' })
  }
})

test('declaresOption matches the plugin name or name@marketplace only, for any listed option', () => {
  expect(declaresOption({ 'coolify@m': { options: { apiKey: '' } } }, 'coolify', ['url', 'apiKey'])).toBe(true)
  expect(declaresOption({ coolify: { options: { url: 'https://evil.com' } } }, 'coolify', ['url', 'apiKey'])).toBe(true)
  expect(declaresOption({ coolifyx: { options: { apiKey: 'x' } } }, 'coolify', ['url', 'apiKey'])).toBe(false)
  expect(declaresOption({ coolify: { options: { other: 1 } } }, 'coolify', ['url', 'apiKey'])).toBe(false)
})

test('resolveAccess reads settings only when both options are valid', async () => {
  let reads = 0
  const counting: AccessIo = { settings: async () => (reads++, undefined) }
  expect(await resolveAccess(counting, { url: URL_OPTION })).toEqual({ off: 'no-key' })
  expect(await resolveAccess(counting, { apiKey: KEY })).toEqual({ off: 'no-url' })
  expect(await resolveAccess(counting, { apiKey: KEY, url: 'http://coolify.example.com' })).toEqual({ off: 'bad-url' })
  expect(reads).toBe(0)
  expect(await resolveAccess(counting, { apiKey: KEY, url: URL_OPTION })).toEqual({ key: KEY, base: 'https://coolify.example.com/api/v1' })
  expect(reads).toBe(2)
})

test('resolveAccess refuses a url or key the repository declares, and unreadable settings', async () => {
  const options = { apiKey: KEY, url: URL_OPTION }
  const url = { pluginConfigs: { 'coolify@spider-claude-mods': { options: { url: 'https://evil.com' } } } }
  const key = { pluginConfigs: { coolify: { options: { apiKey: 'r' } } } }
  expect(await resolveAccess(io({ project: url }), options)).toEqual({ off: 'repo-option' })
  expect(await resolveAccess(io({ local: key }), options)).toEqual({ off: 'repo-option' })
  expect(await resolveAccess({ settings: async () => Promise.reject(new Error('x')) }, options)).toEqual({ off: 'unreadable' })
})

test('no refusal text names a value, and each one points at an option or the settings', () => {
  for (const text of Object.values(OFF_TEXT)) expect(text).toMatch(/url|apiKey/)
  expect(OFF_TEXT['no-key']).toContain('plugin options')
  expect(OFF_TEXT['no-url']).toContain('plugin options')
})
