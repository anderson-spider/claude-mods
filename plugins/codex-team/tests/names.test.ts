import { expect, test } from 'claude-code/testing'
import { effectiveName, logicalName, workspaceToken } from '../hooks/names'

test('workspace tokens preserve case and leading zeroes without hashing or collisions', () => {
  const ids = ['w1', 'w01', 'w001', 'w6F', 'w6f']
  const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  for (const first of digits) for (const second of digits) ids.push(`w${first}${second}`)
  const unique = [...new Set(ids)]
  const tokens = unique.map(workspaceToken)
  expect(tokens.every(token => token !== undefined)).toBe(true)
  expect(new Set(tokens).size).toBe(unique.length)
  expect(workspaceToken('w6F')).not.toBe(workspaceToken('w6f'))
  expect(workspaceToken('w1')).toBe('1r')
  expect(effectiveName('analyst', 'w1')).toBe('n1r')
})

test('all effective roles retain the full longest slug within the Herdr charset and 32 characters', () => {
  const slug = 'a'.repeat(22)
  for (const workspace of ['w1', 'w6F', 'w6f', 'wzzzzzz']) {
    for (const name of ['analyst', 'architect', `analyst-${slug}`, `architect-${slug}`, `dev-${slug}`]) {
      const effective = effectiveName(name, workspace)!
      expect(effective).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
      expect(logicalName(effective, workspace)).toBe(name)
      expect(logicalName(effective, workspace === 'w1' ? 'w2' : 'w1')).toBeUndefined()
      if (name.includes('-')) expect(effective.endsWith(`-${slug}`)).toBe(true)
    }
  }
  expect(effectiveName(`architect-${slug}`, 'wzzzzzz')!.length).toBe(32)
})

test('unsupported workspace ids and invalid logical names fail closed without truncation', () => {
  for (const id of ['', 'W1', 'w-', 'w1:p2', 'wzzzzzzz', 'w' + 'a'.repeat(100)]) {
    expect(workspaceToken(id)).toBeUndefined()
    expect(effectiveName('analyst', id)).toBeUndefined()
  }
  for (const name of ['dev-', 'dev-' + 'a'.repeat(23), 'dev-X', 'other', 'n1r']) {
    expect(effectiveName(name, 'w1')).toBeUndefined()
  }
})
