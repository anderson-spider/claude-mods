import { expect, test } from 'claude-code/testing'
import { modelAllowed, resolveAllowAstra } from '../hooks/model-policy'

test('only effective true allows Astra and absent settings files keep it allowed', async () => {
  const reads: string[] = []
  const io = { settings: async (source: 'project' | 'local') => { reads.push(source); return undefined } }
  expect(await resolveAllowAstra(io, true)).toBe(true)
  expect(reads).toEqual(['project', 'local'])
  for (const value of [false, undefined, null, 'true', 1, {}, [], ['true']]) {
    reads.length = 0
    expect(await resolveAllowAstra(io, value)).toBe(false)
    expect(reads).toEqual([])
  }
})

test('own repository declarations refuse Astra for both sources and plugin aliases regardless of value', async () => {
  for (const source of ['project', 'local'] as const) for (const id of ['codex-team', 'codex-team@inline', 'codex-team@spider-claude-mods', 'codex-team@another']) {
    for (const value of [true, false, null, undefined, 'true', 1]) {
      expect(await resolveAllowAstra({ settings: async current => current === source ? { pluginConfigs: { [id]: { options: { allowAstra: value } } } } : {} }, true)).toBe(false)
    }
  }
})

test('other plugins and configs without an own allowAstra declaration are ignored', async () => {
  const pluginConfigs = { 'other@market': { options: { allowAstra: false } }, 'codex-team-other': { options: { allowAstra: true } }, 'codex-team': null, 'codex-team@inline': { options: { other: true } } }
  expect(await resolveAllowAstra({ settings: async () => ({ pluginConfigs }) }, true)).toBe(true)
})

test('read rejection and malformed pluginConfigs turn Astra off without disabling other models', async () => {
  for (const source of ['project', 'local'] as const) {
    expect(await resolveAllowAstra({ settings: async current => { if (current === source) throw new Error('private error'); return {} } }, true)).toBe(false)
  }
  for (const pluginConfigs of [false, null, 'true', 1, []]) {
    expect(await resolveAllowAstra({ settings: async () => ({ pluginConfigs }) }, true)).toBe(false)
  }
  for (const model of ['gpt-6-astra', 'other-ASTRA-model']) expect(modelAllowed(model, false)).toBe(false)
  for (const model of ['gpt-6.1-sol', 'gpt-6-luna']) expect(modelAllowed(model, false)).toBe(true)
})
