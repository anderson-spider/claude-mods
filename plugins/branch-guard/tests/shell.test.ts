import { expect, test } from 'claude-code/testing'

import { enter, locate, parse, resolve } from '../hooks/shell'

const texts = (command: string) => parse(command).map(one => one.words.map(word => word.text))

test('parse keeps a quoted argument as one word and splits commands on the sequence operators', () => {
  expect(texts('git commit -m "a b"')).toEqual([['git', 'commit', '-m', 'a b']])
  expect(texts('cd repo && git push')).toEqual([['cd', 'repo'], ['git', 'push']])
  expect(parse('cd repo && git push')[1]?.before).toBe('&&')
})

test('parse drops redirection operators and their targets from the words', () => {
  expect(texts('git push origin main &> log')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main &>> log')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main > log 2>&1')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main >log')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main >> log')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main 2>/dev/null')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main 2> err')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main >& log')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main < in')).toEqual([['git', 'push', 'origin', 'main']])
  // The redirection comes first, and `&` next to it never splits the command.
  expect(texts('>log git push origin main')).toEqual([['git', 'push', 'origin', 'main']])
  expect(parse('git push origin main 2>&1 && ls')).toHaveLength(2)
})

test('parse keeps a quoted operator as a normal word', () => {
  expect(texts('echo ">"')).toEqual([['echo', '>']])
  expect(texts("echo '2>&1' x")).toEqual([['echo', '2>&1', 'x']])
  expect(texts('git commit -m "a > b"')).toEqual([['git', 'commit', '-m', 'a > b']])
})

test('parse leaves the braces of a group as words of their commands', () => {
  expect(texts('{ git commit; }')).toEqual([['{', 'git', 'commit'], ['}']])
})

test('resolve joins a relative path to its base and an absolute path wins', () => {
  expect(resolve('/a/b', '../c')).toBe('/a/c')
  expect(resolve('/a', '/x')).toBe('/x')
})

test('enter keeps a home destination as ~ until the home is known', () => {
  expect(enter('/a', '~/x')).toBe('~/x')
})

test('locate resolves a home path from the home, or gives up without one', () => {
  expect(locate('/a', '~/repo', '/home/u')).toBe('/home/u/repo')
  expect(locate('/a', '~/repo', undefined)).toBeUndefined()
})
