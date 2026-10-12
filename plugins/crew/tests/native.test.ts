import { describe, expect, test } from 'claude-code/testing'
import { parseCodexModels } from '../hooks/native'
import { SPECIALISTS } from '../hooks/agents'

// The six roles a `nativeCodex` entry may name: the specialists' names.
const ROLE_NAMES = SPECIALISTS.map(s => s.name)

describe('parseCodexModels', () => {
  test('parses a list', () => {
    expect(parseCodexModels('developer=gpt-x, architect=gpt-y')).toEqual({
      models: { developer: 'gpt-x', architect: 'gpt-y' }, errors: [],
    })
  })

  test('trims and ignores empties', () => {
    expect(parseCodexModels('  developer = gpt-x ,, ,\n tester=m.1:2  ,')).toEqual({
      models: { developer: 'gpt-x', tester: 'm.1:2' }, errors: [],
    })
    expect(parseCodexModels('')).toEqual({ models: {}, errors: [] })
    expect(parseCodexModels('  , ')).toEqual({ models: {}, errors: [] })
  })

  test('rejects unknown roles and keeps the valid ones', () => {
    const r = parseCodexModels('lead=gpt-x, developer=gpt-y, constructor=m')
    expect(r.models).toEqual({ developer: 'gpt-y' })
    expect(r.errors).toHaveLength(2)
  })

  test('rejects bad model ids', () => {
    for (const bad of ['developer=--dangerously-bypass-approvals-and-sandbox', 'developer=-m', 'developer=.x', 'developer=_x', 'developer=:x', 'developer=', 'developer=a b', 'developer=a/b', 'developer=$(x)', `developer=${'a'.repeat(65)}`, 'developer="x"']) {
      const r = parseCodexModels(bad)
      expect(r.models).toEqual({})
      expect(r.errors).toHaveLength(1)
    }
    expect(parseCodexModels(`developer=${'a'.repeat(64)}`).models).toEqual({ developer: 'a'.repeat(64) })
  })

  test('an entry without = is an error', () => {
    const r = parseCodexModels('developer')
    expect(r.models).toEqual({})
    expect(r.errors).toHaveLength(1)
  })

  test('the last entry for a role wins', () => {
    expect(parseCodexModels('developer=a, developer=b').models).toEqual({ developer: 'b' })
  })

  test('never throws on a non-string', () => {
    for (const v of [undefined, null, 5, {}, []]) expect(parseCodexModels(v)).toEqual({ models: {}, errors: [] })
  })

  test('a prototype key is not a role', () => {
    const r = parseCodexModels('__proto__=gpt-x')
    expect(r.errors).toHaveLength(1)
    expect(Object.keys(r.models)).toEqual([])
  })
})

describe('parseCodexModels never throws and never pollutes', () => {
  test('hostile text', () => {
    const inputs = [
      '', '   ', '\n\n', ',,,', '=', '=x', 'developer==x', 'developer=a=b', '__proto__=x', 'constructor=x', 'hasOwnProperty=x',
      'toString=x', 'valueOf=x', ' __proto__ = gpt-x , developer=ok', 'x'.repeat(100000), 'developer=\u0000', 'developer=gpt‮x',
      'DEVELOPER=gpt-x', 'crew:developer=gpt-x',
    ]
    for (const text of inputs) {
      const r = parseCodexModels(text)
      expect(Object.getPrototypeOf(r.models)).toBe(Object.prototype)
      for (const k of Object.keys(r.models)) expect(ROLE_NAMES).toContain(k)
      for (const v of Object.values(r.models)) expect(/^[A-Za-z0-9][\w.:-]{0,63}$/.test(v as string)).toBe(true)
    }
    expect(({} as Record<string, unknown>).x).toBe(undefined)
    expect(parseCodexModels(' __proto__ = gpt-x , developer=ok')).toEqual({ models: { developer: 'ok' }, errors: ['"__proto__": unknown role'] })
    expect(parseCodexModels('DEVELOPER=gpt-x').models).toEqual({})
  })

  test('non-strings, including one whose toString throws', () => {
    const throwing = { toString() { throw new Error('boom') } }
    for (const v of [undefined, null, 0, true, {}, [], throwing, () => 'developer=x', Symbol('s')]) {
      expect(parseCodexModels(v)).toEqual({ models: {}, errors: [] })
    }
  })

  test('duplicates: the last valid one wins and an invalid later one does not erase it', () => {
    expect(parseCodexModels('developer=a\ndeveloper=b, developer=c').models).toEqual({ developer: 'c' })
    const r = parseCodexModels('developer=a, developer=bad id')
    expect(r.models).toEqual({ developer: 'a' })
    expect(r.errors).toHaveLength(1)
  })
})
