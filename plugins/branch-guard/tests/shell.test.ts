import { expect, test } from 'claude-code/testing'

import { enter, locate, parse, resolve } from '../hooks/shell'

const texts = (command: string) => parse(command).map(one => one.words.map(word => word.text))

test('parse keeps a quoted argument as one word and splits commands on the sequence operators', () => {
  expect(texts('git commit -m "a b"')).toEqual([['git', 'commit', '-m', 'a b']])
  expect(texts('cd repo && git push')).toEqual([['cd', 'repo'], ['git', 'push']])
  expect(parse('cd repo && git push')[1]?.before).toBe('&&')
})

test('parse reads today\'s split of redirections and brace groups', () => {
  // `&>` stays a word of the command, so `out` is still an argument.
  expect(texts('git push &> out')).toEqual([['git', 'push', '&>', 'out']])
  // The `{` and `}` are words of their commands, which `classify` does not see as `git`.
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
