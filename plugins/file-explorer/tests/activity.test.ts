import { expect, test } from 'claude-code/testing'
import { FLASH_MS, MARK_MS, MAX_ACTIVITY, MAX_SEARCH_MARKS, commandsOf, marksAt, nextFlashEnd, recorded, shellEffects, touchedBy, writing } from '../hooks/activity'

test('a command line splits into simple commands at separators, quotes kept whole', () => {
  expect(commandsOf(`git commit -m "a; b" && rm 'my file' | cat; echo x\\ y`)).toEqual([
    ['git', 'commit', '-m', 'a; b'], ['rm', 'my file'], ['cat'], ['echo', 'x y'],
  ])
  expect(commandsOf('')).toEqual([])
  expect(commandsOf('a || b & c')).toEqual([['a'], ['b'], ['c']])
})

test('shell effects name the git verbs and the paths made or removed, against the cwd', () => {
  expect(shellEffects('git -C sub commit -m x && git push', '/p').git).toEqual(['commit', 'push'])
  expect(shellEffects('rm -rf build "my notes.md"', '/p').removed).toEqual(['/p/build', '/p/my notes.md'])
  expect(shellEffects('mkdir -p a/b; touch c', '/p').created).toEqual(['/p/a/b', '/p/c'])
  expect(shellEffects('mv a.ts b.ts', '/p')).toEqual({ git: [], created: ['/p/b.ts'], removed: ['/p/a.ts'] })
  expect(shellEffects('cp a.ts lib/', '/p')).toEqual({ git: [], created: ['/p/lib'], removed: [] })
  expect(shellEffects('FOO=1 sudo rm x', '/p').removed).toEqual(['/p/x'])
  expect(shellEffects('ls -la && cat a', '/p')).toEqual({ git: [], created: [], removed: [] })
})

test('each tool names what it touched: a read, a created or updated write, edits, search hits and shell effects', () => {
  expect(touchedBy('Read', { file_path: '/p/a.ts' }, {}, '/p', 5)).toEqual([{ path: '/p/a.ts', kind: 'read', at: 5 }])
  expect(touchedBy('Write', { file_path: '/p/a.ts' }, { type: 'create' }, '/p', 5)[0]?.kind).toBe('created')
  expect(touchedBy('Write', { file_path: '/p/a.ts' }, { type: 'update' }, '/p', 5)[0]?.kind).toBe('modified')
  expect(touchedBy('Edit', { file_path: 'a.ts' }, {}, '/p', 5)[0]?.path).toBe('/p/a.ts')
  expect(touchedBy('MultiEdit', { file_path: '/p/b.ts' }, {}, '/p', 5)[0]?.kind).toBe('modified')
  expect(touchedBy('NotebookEdit', { notebook_path: '/p/n.ipynb' }, {}, '/p', 5)[0]?.path).toBe('/p/n.ipynb')
  const many = Array.from({ length: 80 }, (_, i) => `f${i}.ts`)
  expect(touchedBy('Glob', { pattern: '*' }, { filenames: many }, '/p', 5)).toHaveLength(MAX_SEARCH_MARKS)
  expect(touchedBy('Grep', {}, { filenames: 'nope' }, '/p', 5)).toEqual([])
  expect(touchedBy('Bash', { command: 'rm x' }, {}, '/p', 5)).toEqual([{ path: '/p/x', kind: 'removed', at: 5 }])
  expect(touchedBy('WebFetch', { url: 'x' }, {}, '/p', 5)).toEqual([])
  expect(touchedBy('Read', { file_path: 42 }, {}, '/p', 5)).toEqual([])
})

test('the log keeps the newest per path first, held to its size', () => {
  const list = recorded([{ path: '/a', kind: 'read', at: 1 }], [{ path: '/b', kind: 'read', at: 2 }, { path: '/a', kind: 'modified', at: 2 }])
  expect(list.map(one => `${one.kind} ${one.path}`)).toEqual(['modified /a', 'read /b'])
  const full = recorded([], Array.from({ length: MAX_ACTIVITY + 10 }, (_, i) => ({ path: `/${i}`, kind: 'read' as const, at: i })))
  expect(full).toHaveLength(MAX_ACTIVITY)
  expect(full[0]?.path).toBe(`/${MAX_ACTIVITY + 9}`)
})

test('marks flash for a moment, stay for a while, then go; one timer is due at the next flash end', () => {
  const list = [{ path: '/a', kind: 'modified' as const, at: 1000 }, { path: '/b', kind: 'read' as const, at: 0 }]
  expect(marksAt(list, 1000).get('/a')).toEqual({ kind: 'modified', isFlashing: true })
  expect(marksAt(list, 1000 + FLASH_MS).get('/a')?.isFlashing).toBe(false)
  expect(marksAt(list, MARK_MS + 1).has('/b')).toBe(false)
  expect(nextFlashEnd(list, 1000)).toBe(FLASH_MS)
  expect(nextFlashEnd(list, FLASH_MS)).toBe(1000 + FLASH_MS)
  expect(nextFlashEnd(list, 1000 + FLASH_MS)).toBeUndefined()
})

test('a write names the file it is about to change before it runs; other tools name none', () => {
  expect(writing('Edit', { file_path: 'src/a.ts' }, '/p')).toBe('/p/src/a.ts')
  expect(writing('Write', { file_path: '/p/b.md' }, '/p')).toBe('/p/b.md')
  expect(writing('NotebookEdit', { notebook_path: 'n.ipynb' }, '/p')).toBe('/p/n.ipynb')
  expect(writing('Read', { file_path: '/p/b.md' }, '/p')).toBeUndefined()
  expect(writing('Edit', {}, '/p')).toBeUndefined()
})
