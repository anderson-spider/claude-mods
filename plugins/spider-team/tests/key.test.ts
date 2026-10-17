import { expect, test } from 'claude-code/testing'
import { checkKey, isOff, OFF_TEXT, OFFS, repoDeclares, resolveAccess } from '../hooks/key'
import type { KeyIo } from '../hooks/key'

const KEY = ['key-', 'test', '-0123456789'].join('')
function io(over: { project?: { env?: unknown }; local?: { env?: unknown }; fail?: string }): KeyIo & { reads: string[] } {
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
  expect(await resolveAccess(source, KEY)).toEqual({ key: KEY })
  expect(source.reads).toEqual(['project', 'local'])
  for (const [value, off] of [[undefined, 'no-key'], ['', 'no-key'], ['two words', 'bad-key'], [7, 'bad-key']] as const) {
    const source = io({})
    expect(await resolveAccess(source, value)).toEqual({ off })
    expect(source.reads).toEqual([])
  }
})

test('settings that cannot be read turn Jev off', async () => {
  for (const source of ['project', 'local']) expect(await resolveAccess(io({ fail: source }), KEY)).toEqual({ off: 'unreadable-settings' })
})

test('any repository env declaration of JEV_API_KEY is refused', async () => {
  for (const source of ['project', 'local']) {
    for (const value of [KEY, '', null, false]) {
      expect(await resolveAccess(io({ [source]: { env: { JEV_API_KEY: value } } }), KEY)).toEqual({ off: 'repo-declared-key' })
    }
  }
  expect(await repoDeclares(io({ project: { env: { OTHER: KEY } } }))).toBe(false)
  expect(await repoDeclares(io({ local: { env: Object.create({ JEV_API_KEY: KEY }) } }))).toBe(false)
})
test('each configuration reason has a fix text naming JEV_API_KEY, and Jev failures are not configuration reasons', () => {
  expect(Object.keys(OFF_TEXT).sort()).toEqual([...OFFS].sort())
  for (const off of OFFS) { expect(isOff(off)).toBe(true); expect(OFF_TEXT[off]).toContain('JEV_API_KEY') }
  for (const reason of ['timeout', 'http', 'breaker', 'config', null, undefined, 7]) expect(isOff(reason)).toBe(false)
})
