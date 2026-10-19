import { expect, test } from 'claude-code/testing'
import { checkKey, declaresOption, isOff, OFF_TEXT, OFFS, pickSource, repoDeclares, resolveAccess } from '../hooks/key'
import type { KeyIo } from '../hooks/key'

const KEY = ['key-', 'test', '-0123456789'].join('')
type Settings = { env?: unknown; pluginConfigs?: unknown }
function io(over: { project?: Settings; local?: Settings; fail?: string }): KeyIo & { reads: string[] } {
  const reads: string[] = []
  return { reads, settings: async source => {
    reads.push(source)
    if (source === over.fail) throw new Error('unreadable')
    return over[source]
  } }
}

test('a key is a trimmed string of printable characters; empty is off silently, anything else is bad', () => {
  expect(checkKey(KEY)).toEqual({ key: KEY })
  expect(checkKey(`  ${KEY}\n`)).toEqual({ key: KEY })
  for (const empty of [undefined, null, '', '   ']) expect(checkKey(empty)).toEqual({ off: 'no-key' })
  for (const bad of ['two words', 'a\nb', 'a\tb', 'a\u0000b', 'a\u007fb', 'café', 'x'.repeat(513), 42, {}, true]) expect(checkKey(bad)).toEqual({ off: 'bad-key' })
  expect(checkKey('x'.repeat(512))).toEqual({ key: 'x'.repeat(512) })
})

test('a valid key reads both settings sources once; no key or a bad key reads neither', async () => {
  const source = io({})
  expect(await resolveAccess(source, { env: KEY })).toEqual({ key: KEY, source: 'env' })
  expect(source.reads).toEqual(['project', 'local'])
  for (const [value, off] of [[undefined, 'no-key'], ['', 'no-key'], ['two words', 'bad-key'], [7, 'bad-key']] as const) {
    const source = io({})
    expect(await resolveAccess(source, { env: value })).toEqual({ off })
    expect(source.reads).toEqual([])
    expect(await resolveAccess(source, { option: value === '' ? undefined : value })).toEqual({ off })
    expect(source.reads).toEqual([])
  }
})

test('settings that cannot be read turn Jev off', async () => {
  for (const source of ['project', 'local']) for (const keys of [{ env: KEY }, { option: KEY }]) expect(await resolveAccess(io({ fail: source }), keys)).toEqual({ off: 'unreadable-settings' })
})

test('any repository env declaration of JEV_API_KEY is refused', async () => {
  for (const source of ['project', 'local']) {
    for (const value of [KEY, '', null, false]) {
      expect(await resolveAccess(io({ [source]: { env: { JEV_API_KEY: value } } }), { env: KEY })).toEqual({ off: 'repo-declared-key' })
    }
  }
  expect(await repoDeclares(io({ project: { env: { OTHER: KEY } } }), 'env')).toBe(false)
  expect(await repoDeclares(io({ local: { env: Object.create({ JEV_API_KEY: KEY }) } }), 'env')).toBe(false)
})

test('the apiKey option wins over JEV_API_KEY; an absent, null or blank option falls back to the environment', async () => {
  const OTHER = ['env-', 'test', '-key'].join('')
  expect(await resolveAccess(io({}), { option: KEY, env: OTHER })).toEqual({ key: KEY, source: 'option' })
  for (const option of [undefined, null, '', '  ']) expect(await resolveAccess(io({}), { option, env: OTHER })).toEqual({ key: OTHER, source: 'env' })
  // A malformed option is the option's own problem, never masked by the environment.
  expect(await resolveAccess(io({}), { option: 'two words', env: OTHER })).toEqual({ off: 'bad-key' })
  expect(pickSource({ option: 7, env: OTHER })).toEqual({ source: 'option', value: 7 })
})

test('a repository declaration of the apiKey option is refused, and only the declaration of the source in use counts', async () => {
  const declared = { pluginConfigs: { 'subagent-effort@spider-claude-mods': { options: { apiKey: 'repo-key-123' } } } }
  for (const source of ['project', 'local']) {
    expect(await resolveAccess(io({ [source]: declared }), { option: KEY })).toEqual({ off: 'repo-declared-key' })
    // The env source ignores a declared option, and the option source ignores a declared JEV_API_KEY.
    expect(await resolveAccess(io({ [source]: declared }), { env: KEY })).toEqual({ key: KEY, source: 'env' })
    expect(await resolveAccess(io({ [source]: { env: { JEV_API_KEY: KEY } } }), { option: KEY })).toEqual({ key: KEY, source: 'option' })
  }
  expect(declaresOption({ 'subagent-effort': { options: { apiKey: '' } } })).toBe(true)
  expect(declaresOption({ 'subagent-effortx': { options: { apiKey: 'x' } } })).toBe(false)
  expect(declaresOption({ 'subagent-effort': { options: {} } })).toBe(false)
  expect(declaresOption(null)).toBe(false)
})
test('each configuration reason has a fix text naming the apiKey option and JEV_API_KEY, and Jev failures are not configuration reasons', () => {
  expect(Object.keys(OFF_TEXT).sort()).toEqual([...OFFS].sort())
  for (const off of OFFS) { expect(isOff(off)).toBe(true); expect(OFF_TEXT[off]).toContain('JEV_API_KEY'); expect(OFF_TEXT[off]).toContain('apiKey') }
  for (const reason of ['timeout', 'http', 'breaker', 'config', null, undefined, 7]) expect(isOff(reason)).toBe(false)
})
