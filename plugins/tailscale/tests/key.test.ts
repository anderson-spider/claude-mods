import { expect, test } from 'claude-code/testing'
import { OFF_TEXT, checkKey, declaresOption, resolveKey, type KeyIo } from '../hooks/key'

const KEY = 'tskey-api-test'
const io = (sources: Partial<Record<'project' | 'local', { pluginConfigs?: unknown }>> = {}): KeyIo => ({
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

test('declaresOption matches the plugin name or name@marketplace only', () => {
  expect(declaresOption({ 'tailscale@m': { options: { apiKey: '' } } }, 'tailscale', 'apiKey')).toBe(true)
  expect(declaresOption({ tailscalex: { options: { apiKey: 'x' } } }, 'tailscale', 'apiKey')).toBe(false)
  expect(declaresOption({ tailscale: { options: {} } }, 'tailscale', 'apiKey')).toBe(false)
})

test('resolveKey reads settings only for a valid key', async () => {
  let reads = 0
  const counting: KeyIo = { settings: async () => (reads++, undefined) }
  expect(await resolveKey(counting, undefined)).toEqual({ off: 'no-key' })
  expect(reads).toBe(0)
  expect(await resolveKey(counting, KEY)).toEqual({ key: KEY })
  expect(reads).toBe(2)
})

test('resolveKey refuses a key the repository declares, and unreadable settings', async () => {
  const declared = { pluginConfigs: { 'tailscale@spider-claude-mods': { options: { apiKey: 'r' } } } }
  expect(await resolveKey(io({ project: declared }), KEY)).toEqual({ off: 'repo-key' })
  expect(await resolveKey(io({ local: declared }), KEY)).toEqual({ off: 'repo-key' })
  expect(await resolveKey({ settings: async () => Promise.reject(new Error('x')) }, KEY)).toEqual({ off: 'unreadable' })
})

test('no refusal text names a value, and each one points at the option or the settings', () => {
  for (const text of Object.values(OFF_TEXT)) expect(text).toMatch(/apiKey/)
  expect(OFF_TEXT['no-key']).toContain('plugin options')
})
