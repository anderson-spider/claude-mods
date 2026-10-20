import { expect, test } from 'claude-code/testing'
import { wrap } from '../hooks/text'

test('wrap breaks at spaces within the width, splits a word longer than a line and ends a cut in …', () => {
  expect(wrap('', 10, 2)).toEqual([])
  expect(wrap('alpha beta', 10, 2)).toEqual(['alpha beta'])
  expect(wrap('alpha beta gamma', 10, 2)).toEqual(['alpha beta', 'gamma'])
  expect(wrap('abcdefghijklmn', 5, 3)).toEqual(['abcde', 'fghij', 'klmn'])
  expect(wrap('alpha beta gamma delta', 10, 2)).toEqual(['alpha beta', 'gamma del…'])
  expect(wrap('aaaaaaaa bbbbbbbbbb', 10, 1)).toEqual(['aaaaaaaa…'])
  expect(wrap('x', 0, 2)).toEqual([])
})
