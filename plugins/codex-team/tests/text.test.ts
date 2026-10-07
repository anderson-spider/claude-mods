import { expect, test } from 'claude-code/testing'
import { appendNote, messageOf } from '../hooks/text'

test('messageOf reads the message of an Error', () => {
  expect(messageOf(new Error('x'))).toBe('x')
})

test('messageOf stringifies a value that is not an Error', () => {
  expect(messageOf('y')).toBe('y')
})

test('appendNote sets the first note as the error', () => {
  const target: { error?: string } = {}
  appendNote(target, 'a')
  expect(target).toEqual({ error: 'a' })
})

test('appendNote puts each later note on its own line', () => {
  const target: { error?: string } = { error: 'a' }
  appendNote(target, 'b')
  expect(target).toEqual({ error: 'a\nb' })
})
