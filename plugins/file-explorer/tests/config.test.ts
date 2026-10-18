import { expect, test } from 'claude-code/testing'
import { DEFAULTS, DEFAULT_IGNORE, configOf } from '../hooks/config'

test('no options are the defaults', () => {
  expect(configOf(undefined)).toEqual(DEFAULTS)
  expect(configOf({})).toEqual(DEFAULTS)
})

test('a value of the wrong kind or outside its choices falls back to its default', () => {
  const config = configOf({ autoOpen: 'yes', sort: 'size', icons: 3, theme: 'neon', git: null, refreshSeconds: Number.NaN, editor: 7 })
  expect(config).toEqual(DEFAULTS)
})

test('ignored names are split on commas, trimmed, and a name with a slash is dropped', () => {
  expect(configOf({ ignore: ' vendor , ,tmp,a/b ' }).ignore).toEqual(['vendor', 'tmp'])
  expect(configOf({ ignore: 5 }).ignore).toEqual(DEFAULT_IGNORE)
})

test('the background check is off at 0 and otherwise held between 2 seconds and 10 minutes', () => {
  expect(configOf({ refreshSeconds: 0 }).refreshSeconds).toBe(0)
  expect(configOf({ refreshSeconds: -3 }).refreshSeconds).toBe(0)
  expect(configOf({ refreshSeconds: 1 }).refreshSeconds).toBe(2)
  expect(configOf({ refreshSeconds: 99_999 }).refreshSeconds).toBe(600)
  expect(configOf({ sort: 'modified', editor: '  code {path} ' })).toMatchObject({ sort: 'modified', editor: 'code {path}' })
})
