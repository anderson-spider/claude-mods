import { expect, test } from 'claude-code/testing'
import { ancestors, base, isInside, join, mention, normalize, parent, relative, resolve } from '../hooks/paths'

test('paths are normalized to forward slashes with dots, doubled and trailing slashes folded', () => {
  expect(normalize('/a//b/./c/../d/')).toBe('/a/b/d')
  expect(normalize('C:\\repo\\src\\..\\lib')).toBe('C:/repo/lib')
  expect(normalize('/../..')).toBe('/')
  expect(normalize('a/../../b')).toBe('../b')
  expect(join('/proj', 'my file.ts')).toBe('/proj/my file.ts')
  expect(resolve('/proj/src', '../README.md')).toBe('/proj/README.md')
  expect(resolve('/proj', '/etc/hosts')).toBe('/etc/hosts')
})

test('a path is inside a root only under a whole part of it, never by a shared prefix', () => {
  expect(isInside('/proj', '/proj/src/a.ts')).toBe(true)
  expect(isInside('/proj', '/proj')).toBe(true)
  expect(isInside('/proj', '/project/a.ts')).toBe(false)
  expect(relative('/proj', '/proj/src/a.ts')).toBe('src/a.ts')
  expect(relative('/proj', '/other/a.ts')).toBeUndefined()
  expect(relative('/', '/etc')).toBe('etc')
})

test('ancestors run from the root down to the folder holding the path', () => {
  expect(ancestors('/proj', '/proj/src/lib/util.ts')).toEqual(['/proj', '/proj/src', '/proj/src/lib'])
  expect(ancestors('/proj', '/proj')).toEqual([])
  expect(ancestors('/proj', '/elsewhere/x')).toEqual([])
  expect(parent('/proj/a')).toBe('/proj')
  expect(parent('/a')).toBe('/')
  expect(base('/proj/src/a.ts')).toBe('a.ts')
})

test('a mention quotes a path with spaces and keeps others bare', () => {
  expect(mention('src/a.ts')).toBe('@src/a.ts')
  expect(mention('my notes.md')).toBe('@"my notes.md"')
})
