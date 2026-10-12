import { expect, test } from 'claude-code/testing'
import { checkKey, declaresOption, resolveAccess, resolveLoginHome } from '../hooks/key'
import type { KeyIo } from '../hooks/key'

// Key-shaped fixtures are assembled at runtime so no source literal matches a secret scanner.
const KEY = ['key-', 'opt', '-0123456789'].join('')

function io(over: { project?: { env?: unknown; pluginConfigs?: unknown }; local?: { env?: unknown; pluginConfigs?: unknown }; settingsFail?: boolean; home?: string | undefined }): KeyIo & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    settings: async source => {
      reads.push(source)
      if (over.settingsFail) throw new Error('unreadable')
      return source === 'project' ? over.project : over.local
    },
    home: async () => ('home' in over ? over.home : '/home/u'),
  }
}

test('a key is a trimmed string of printable characters; empty is off silently, anything else is bad', () => {
  expect(checkKey(KEY)).toEqual({ key: KEY })
  expect(checkKey(`  ${KEY}\n`)).toEqual({ key: KEY })
  for (const empty of [undefined, null, '', '   ']) expect(checkKey(empty)).toEqual({ off: 'no-key' })
  for (const bad of ['two words', 'a\nb', 'a\tb', 'café', 'x'.repeat(513), 42, {}, true]) expect(checkKey(bad)).toEqual({ off: 'bad-key' })
  expect(checkKey('x'.repeat(512))).toEqual({ key: 'x'.repeat(512) })
})

test('a valid key with a trusted home gives both, reading each settings source once', async () => {
  const source = io({})
  expect(await resolveAccess(source, KEY)).toEqual({ key: KEY, home: '/home/u' })
  expect(source.reads).toEqual(['project', 'local'])
  expect(await resolveAccess(io({ home: '/home/u/' }), ` ${KEY} `)).toEqual({ key: KEY, home: '/home/u' })
})

test('no key or a bad key is off without reading the settings', async () => {
  for (const [option, off] of [[undefined, 'no-key'], ['', 'no-key'], ['  ', 'no-key'], ['two words', 'bad-key'], [7, 'bad-key']] as const) {
    const source = io({})
    expect(await resolveAccess(source, option)).toEqual({ off })
    expect(source.reads).toEqual([])
  }
})

test('settings that cannot be read turn routing off', async () => {
  expect(await resolveAccess(io({ settingsFail: true }), KEY)).toEqual({ off: 'unreadable' })
})

test('a jevKey that the repository settings declare turns routing off', async () => {
  const declared = { 'crew@spider-claude-mods': { options: { jevKey: KEY } } }
  expect(await resolveAccess(io({ project: { pluginConfigs: declared } }), KEY)).toEqual({ off: 'repo-key' })
  expect(await resolveAccess(io({ local: { pluginConfigs: { 'crew@inline': { options: { jevKey: 'x' } } } } }), KEY)).toEqual({ off: 'repo-key' })
  expect(await resolveAccess(io({ project: { pluginConfigs: { crew: { options: { other: 1 } } } } }), KEY)).toEqual({ key: KEY, home: '/home/u' })
})

test('a HOME that the repository settings declare, or a relative one, is not trusted; the key still counts', async () => {
  expect(await resolveAccess(io({ project: { env: { HOME: '/home/u' } } }), KEY)).toEqual({ key: KEY })
  expect(await resolveAccess(io({ local: { env: { HOME: '/elsewhere' } } }), KEY)).toEqual({ key: KEY })
  for (const home of ['.', 'repo', '', '  ', '~', undefined]) expect(await resolveAccess(io({ home }), KEY)).toEqual({ key: KEY })
  // Declared elsewhere in the env block, HOME is still the user's.
  expect(await resolveAccess(io({ project: { env: { OTHER: '1' } } }), KEY)).toEqual({ key: KEY, home: '/home/u' })
})

test('a repository declares the option under crew or crew@marketplace, any value', () => {
  expect(declaresOption({ crew: { options: { jevKey: 'x' } } }, 'crew', 'jevKey')).toBe(true)
  expect(declaresOption({ 'crew@spider-claude-mods': { options: { jevKey: '' } } }, 'crew', 'jevKey')).toBe(true)
  expect(declaresOption({ crew: { options: {} }, other: { options: { jevKey: 'x' } } }, 'crew', 'jevKey')).toBe(false)
  expect(declaresOption({ crewx: { options: { jevKey: 'x' } } }, 'crew', 'jevKey')).toBe(false)
  expect(declaresOption(undefined, 'crew', 'jevKey')).toBe(false)
})

// --- The Codex login's home ---

test('the Codex login reads the trusted home, reading each settings source once', async () => {
  const source = io({ home: '/home/u/' })
  expect(await resolveLoginHome(source)).toEqual({ home: '/home/u' })
  expect(source.reads).toEqual(['project', 'local'])
})

test('a repository that sets codexLogin or declares HOME, unreadable settings and a relative home turn the Codex login off', async () => {
  expect(await resolveLoginHome(io({ project: { pluginConfigs: { 'crew@spider-claude-mods': { options: { codexLogin: true } } } } }))).toEqual({ off: 'repo-option' })
  expect(await resolveLoginHome(io({ local: { pluginConfigs: { crew: { options: { codexLogin: false } } } } }))).toEqual({ off: 'repo-option' })
  expect(await resolveLoginHome(io({ project: { env: { HOME: '/tmp/attacker' } } }))).toEqual({ off: 'repo-home' })
  expect(await resolveLoginHome(io({ settingsFail: true }))).toEqual({ off: 'unreadable' })
  expect(await resolveLoginHome(io({ home: 'relative/home' }))).toEqual({ off: 'no-home' })
  expect(await resolveLoginHome(io({ home: undefined }))).toEqual({ off: 'no-home' })
})
