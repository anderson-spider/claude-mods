import { expect, test } from 'claude-code/testing'
import { MAX_HITS, rank, score, withDirectories } from '../hooks/search'

const INDEX = ['src/register.tsx', 'src/lib/registry.ts', 'docs/register-notes.md', 'tests/register.test.ts', 'README.md', '.github/ci.yml']

test('an exact name ranks first, then a name that starts with the query, then one that holds it, then the path', () => {
  expect(rank(INDEX, 'register.tsx', { mode: 'fuzzy', showHidden: false })[0]).toBe('src/register.tsx')
  expect(rank(INDEX, 'regis', { mode: 'substring', showHidden: false })).toEqual(['src/register.tsx', 'src/lib/registry.ts', 'docs/register-notes.md', 'tests/register.test.ts'])
  expect(score('src/lib/a.ts', 'lib', 'substring')).toBeGreaterThan(0)
})

test('fuzzy matches the letters in order, substring needs them together; case never matters', () => {
  expect(rank(INDEX, 'rgtx', { mode: 'fuzzy', showHidden: false })).toEqual(['src/register.tsx'])
  expect(rank(INDEX, 'rgtx', { mode: 'substring', showHidden: false })).toEqual([])
  expect(rank(INDEX, 'README', { mode: 'substring', showHidden: false })).toEqual(['README.md'])
  expect(rank(INDEX, '   ', { mode: 'fuzzy', showHidden: false })).toEqual([])
})

test('hidden paths are found only while hidden files are shown', () => {
  expect(rank(INDEX, 'ci', { mode: 'substring', showHidden: false })).toEqual([])
  expect(rank(INDEX, 'ci', { mode: 'substring', showHidden: true })).toEqual(['.github/ci.yml'])
})

test('hits are held to their limit, and folders join the index once each', () => {
  const big = Array.from({ length: 1000 }, (_, i) => `f/${i}.ts`)
  expect(rank(big, 'ts', { mode: 'fuzzy', showHidden: false })).toHaveLength(MAX_HITS)
  expect(withDirectories(['a/b/c.ts', 'a/b/d.ts', 'e.ts']).sort()).toEqual(['a', 'a/b', 'a/b/c.ts', 'a/b/d.ts', 'e.ts'])
})
