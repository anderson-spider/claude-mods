import { expect, test } from 'claude-code/testing'
import { confirmText, createConfirmations, ranAsPlanned } from '../hooks/confirm'
import type { Pending } from '../hooks/confirm'

const planned = { model: 'opus', effort: 'high' }

test('a run matches when the model id is of the planned family and the effort is the planned one', () => {
  expect(ranAsPlanned(planned, { model: 'claude-opus-5-5', effort: 'high' })).toBe(true)
  expect(ranAsPlanned(planned, { model: 'claude-opus-5-5[1m]', effort: 'high' })).toBe(true)
  expect(ranAsPlanned(planned, { model: 'claude-sonnet-5-5', effort: 'high' })).toBe(false)
  expect(ranAsPlanned(planned, { model: 'claude-opus-5-5', effort: 'medium' })).toBe(false)
  expect(ranAsPlanned(planned, { model: 'claude-opus-5-5', effort: undefined })).toBe(false)
})

test('the line confirms, or names what ran and the tag it missed', () => {
  expect(confirmText('audit auth', planned, { model: 'claude-opus-5-5', effort: 'high' })).toBe('crew jev: audit auth: confirmed claude-opus-5-5 · high')
  expect(confirmText('audit auth', planned, { model: 'claude-opus-5-5', effort: undefined })).toBe(
    'crew jev: audit auth: ran claude-opus-5-5 · no effort, not opus/high',
  )
})

test('an entry is taken once, and the oldest go past the cap', () => {
  const confirms = createConfirmations()
  const entry = { description: 'd', planned } as unknown as Pending
  confirms.add('a1', entry)
  expect(confirms.take('a1')).toBe(entry)
  expect(confirms.take('a1')).toBeUndefined()

  for (let i = 0; i < 65; i++) confirms.add(`b${i}`, entry)
  expect(confirms.take('b0')).toBeUndefined()
  expect(confirms.take('b64')).toBe(entry)
})
