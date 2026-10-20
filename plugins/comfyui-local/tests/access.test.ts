import { expect, test } from 'claude-code/testing'
import { OFF_TEXT, checkUrl, declaredOptions, repoChose, resolveAccess, type AccessIo } from '../hooks/access'

const URL_OPTION = 'http://192.168.0.10:8188'
const io = (sources: Partial<Record<'user' | 'project' | 'local', { pluginConfigs?: unknown }>> = {}): AccessIo => ({
  settings: async (source) => sources[source],
})

test('checkUrl keeps an http or https origin', () => {
  expect(checkUrl(URL_OPTION)).toEqual({ base: URL_OPTION })
  expect(checkUrl(' http://192.168.0.10:8188/ ')).toEqual({ base: URL_OPTION })
  expect(checkUrl('https://Comfy.Example.com')).toEqual({ base: 'https://comfy.example.com' })
  expect(checkUrl('http://comfy.local:8188')).toEqual({ base: 'http://comfy.local:8188' })
})

test('checkUrl refuses a missing url, another scheme, credentials, a path, a query or a fragment', () => {
  expect(checkUrl(undefined)).toEqual({ off: 'no-url' })
  expect(checkUrl(' ')).toEqual({ off: 'no-url' })
  for (const bad of [5, '192.168.0.10:8188', 'ftp://comfy.local', 'http://user:pass@comfy.local', 'http://comfy.local/api', 'http://comfy.local/?x=1', 'http://comfy.local/#x']) {
    expect(checkUrl(bad)).toEqual({ off: 'bad-url' })
  }
})

test('declaredOptions reads the url under the plugin name or name@marketplace', () => {
  const configs = { 'comfyui-local': { options: { url: 'a' } }, 'comfyui-local@claude-mods': { options: { url: 'b' } }, other: { options: { url: 'c' } } }
  expect(declaredOptions(configs, 'comfyui-local', ['url'])).toEqual(new Map([['url', ['a', 'b']]]))
  expect(declaredOptions(undefined, 'comfyui-local', ['url']).size).toBe(0)
})

test('repoChose is true only for a value the user does not declare', () => {
  const user = new Map([['url', ['a']]])
  expect(repoChose(new Map([['url', ['a']]]), user)).toBe(false)
  expect(repoChose(new Map([['url', ['b']]]), user)).toBe(true)
  expect(repoChose(new Map(), user)).toBe(false)
})

test('resolveAccess answers the base, or why there is none', async () => {
  expect(await resolveAccess(io(), { url: URL_OPTION })).toEqual({ base: URL_OPTION })
  expect(await resolveAccess(io(), {})).toEqual({ off: 'no-url' })
  expect(await resolveAccess(io(), { url: 'nope' })).toEqual({ off: 'bad-url' })
  const repo = { pluginConfigs: { 'comfyui-local': { options: { url: 'http://evil.example' } } } }
  expect(await resolveAccess(io({ project: repo }), { url: URL_OPTION })).toEqual({ off: 'repo-option' })
  expect(await resolveAccess(io({ local: repo }), { url: URL_OPTION })).toEqual({ off: 'repo-option' })
  const same = { pluginConfigs: { 'comfyui-local': { options: { url: URL_OPTION } } } }
  expect(await resolveAccess(io({ user: same, project: same }), { url: URL_OPTION })).toEqual({ base: URL_OPTION })
  const failing: AccessIo = { settings: async () => { throw new Error('unreadable') } }
  expect(await resolveAccess(failing, { url: URL_OPTION })).toEqual({ off: 'unreadable' })
})

test('no refusal text carries a value, and each names where to set the option', () => {
  for (const text of Object.values(OFF_TEXT)) {
    expect(text).not.toContain('192.168')
    expect(text).toContain('comfyui-local')
  }
})
