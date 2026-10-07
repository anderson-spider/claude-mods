import { expect, test } from 'claude-code/testing'
import { requestOf, loopOf } from '../hooks/requests'

test('requestOf rejects an empty task and trims the valid ones', () => {
  expect(typeof requestOf('execute', {})).toBe('string')
  expect(typeof requestOf('execute', { task: '  ' })).toBe('string')
  expect(requestOf('execute', { task: ' t ', files: ['a', 3, ''] })).toEqual({ kind: 'execute', task: 't', files: ['a'] })
  expect(requestOf('review', {})).toEqual({ kind: 'review', task: '', files: [] })
})

test('loopOf requires a task, trims files and defaults maxRounds to three', () => {
  expect(typeof loopOf({})).toBe('string')
  expect(typeof loopOf({ task: '  ' })).toBe('string')
  expect(loopOf({ task: ' add X ', files: [' a.ts ', '', 4] })).toEqual({ task: 'add X', files: ['a.ts'], maxRounds: 3 })
  expect(loopOf({ task: 'add X', maxRounds: 1 })).toEqual({ task: 'add X', files: [], maxRounds: 1 })
})

test('loopOf rejects maxRounds unless it is an integer at least one', () => {
  for (const maxRounds of [0, -1, 1.5, '3', null, true, NaN, Infinity]) {
    expect(loopOf({ task: 'add X', maxRounds })).toBe('Give maxRounds as an integer at least 1.')
  }
})
