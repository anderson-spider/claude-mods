import { expect, test } from 'claude-code/testing'
import { confirmText, createConfirmations, normalizeModel, ranAsPlanned } from '../hooks/confirm'
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
  expect(confirmText('audit auth', planned, { model: 'claude-opus-5-5', effort: 'high' })).toBe('jev: audit auth: confirmed claude-opus-5-5 · high')
  expect(confirmText('audit auth', planned, { model: 'claude-opus-5-5', effort: undefined })).toBe(
    'jev: audit auth: ran claude-opus-5-5 · no effort, not opus/high',
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

test('normalizeModel strips case, a trailing context suffix and a trailing effort suffix, in that order, once', () => {
  expect(normalizeModel('GPT-6-Astra')).toBe('gpt-6-astra')
  expect(normalizeModel('gpt-6-astra-high')).toBe('gpt-6-astra')
  expect(normalizeModel('gpt-6-astra:high')).toBe('gpt-6-astra')
  expect(normalizeModel('gpt-6-astra-xhigh')).toBe('gpt-6-astra')
  expect(normalizeModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
  expect(normalizeModel('claude-opus-5-5[2m]')).toBe('claude-opus-5-5')
  expect(normalizeModel('gpt-6-astra-low[1m]')).toBe('gpt-6-astra')
  expect(normalizeModel('gpt-6-astra-high-high')).toBe('gpt-6-astra-high')
  expect(normalizeModel('gpt-5.3-codex-max')).toBe('gpt-5.3-codex-max')
})

test('a model id other than an alias must match exactly once normalized, not by substring', () => {
  const codex = { model: 'gpt-6-astra', effort: 'high' }
  expect(ranAsPlanned(codex, { model: 'gpt-6-astra', effort: 'high' })).toBe(true)
  expect(ranAsPlanned(codex, { model: 'GPT-6-ASTRA', effort: 'high' })).toBe(true)
  expect(ranAsPlanned(codex, { model: 'gpt-6-astra-high', effort: 'high' })).toBe(true)
  expect(ranAsPlanned(codex, { model: 'gpt-6-astra:high', effort: 'high' })).toBe(true)
  expect(ranAsPlanned(codex, { model: 'gpt-6-astra[1m]', effort: 'high' })).toBe(true)
  expect(ranAsPlanned({ model: 'gpt-6-astra-high', effort: 'high' }, { model: 'gpt-6-astra', effort: 'high' })).toBe(true)
  expect(ranAsPlanned(codex, { model: 'gpt-6-astra-mini', effort: 'high' })).toBe(false)
  expect(ranAsPlanned({ model: 'gpt-6', effort: 'high' }, { model: 'gpt-6-mini', effort: 'high' })).toBe(false)
  expect(ranAsPlanned({ model: 'gpt-6', effort: 'high' }, { model: 'xgpt-6', effort: 'high' })).toBe(false)
  expect(ranAsPlanned({ model: 'gpt-5.3-codex', effort: 'high' }, { model: 'gpt-5.3-codex-max', effort: 'high' })).toBe(false)
  expect(ranAsPlanned(codex, { model: 'claude-opus-5-5', effort: 'high' })).toBe(false)
  expect(ranAsPlanned(codex, { model: 'gpt-6-astra', effort: 'medium' })).toBe(false)
  expect(ranAsPlanned(codex, { model: 'gpt-6-astra', effort: undefined })).toBe(false)
})

test('an alias is still matched by the Claude id that contains it, and only an alias', () => {
  for (const [alias, id] of [['haiku', 'claude-3-5-haiku-20241022'], ['sonnet', 'claude-sonnet-5-5'], ['opus', 'claude-opus-5-5[1m]'], ['opus', 'Claude-Opus-5-5']] as const) {
    expect(ranAsPlanned({ model: alias, effort: 'medium' }, { model: id, effort: 'medium' })).toBe(true)
  }
  expect(ranAsPlanned({ model: 'opus', effort: 'medium' }, { model: 'claude-sonnet-5-5', effort: 'medium' })).toBe(false)
  expect(ranAsPlanned({ model: 'claude-opus-5-5', effort: 'medium' }, { model: 'claude-opus-5-5-20260101', effort: 'medium' })).toBe(true)
  expect(ranAsPlanned({ model: 'claude-opus-5-5', effort: 'medium' }, { model: 'claude-opus-5-5-mini', effort: 'medium' })).toBe(false)
})

// --- Codex ids ---

test('a Codex id compares exactly once normalized, and its dated release matches too', () => {
  const p = { model: 'gpt-6-astra', effort: 'high' }
  for (const model of ['gpt-6-astra', 'GPT-6-Astra', 'gpt-6-astra-high', 'gpt-6-astra:high', 'gpt-6-astra-low', 'gpt-6-astra-xhigh', 'gpt-6-astra[1m]', 'gpt-6-astra-high[1m]', ' gpt-6-astra ', 'gpt-6-astra-2026-05-01', 'gpt-6-astra-20260501', 'GPT-6-Astra-2026-05-01-high', 'gpt-6-astra-2026-05-01[1m]']) {
    expect(ranAsPlanned(p, { model, effort: 'high' })).toBe(true)
  }
  for (const model of ['gpt-6-astra-mini', 'gpt-6-astr', 'gpt-6', 'gpt-6-astra-max', 'claude-sonnet-5-5', 'gpt-6-astra-mini-2026-05-01', 'gpt-6-astra[1m]-high']) {
    expect(ranAsPlanned(p, { model, effort: 'high' })).toBe(false)
  }
  expect(ranAsPlanned({ model: 'gpt-6-astra-mini', effort: 'high' }, { model: 'gpt-6-astra', effort: 'high' })).toBe(false)
  expect(ranAsPlanned(p, { model: 'gpt-6-astra', effort: 'medium' })).toBe(false)
  expect(ranAsPlanned(p, { model: 'gpt-6-astra', effort: undefined })).toBe(false)
  expect(normalizeModel('gpt-x-codex-max')).toBe('gpt-x-codex-max')
})

test('Claude aliases still match their full ids, as before; a full planned id also takes its dated release', () => {
  expect(ranAsPlanned({ model: 'opus', effort: 'high' }, { model: 'claude-opus-5-5', effort: 'high' })).toBe(true)
  expect(ranAsPlanned({ model: 'opus', effort: 'high' }, { model: 'claude-opus-5-5[1m]', effort: 'high' })).toBe(true)
  expect(ranAsPlanned({ model: 'sonnet', effort: 'medium' }, { model: 'claude-sonnet-5-5-20260101', effort: 'medium' })).toBe(true)
  expect(ranAsPlanned({ model: 'sonnet', effort: 'high' }, { model: 'claude-opus-5-5', effort: 'high' })).toBe(false)
  expect(ranAsPlanned({ model: 'haiku', effort: 'medium' }, { model: 'claude-haiku-5-5', effort: 'high' })).toBe(false)
  expect(ranAsPlanned({ model: 'claude-opus-5-5', effort: 'high' }, { model: 'claude-opus-5-5', effort: 'high' })).toBe(true)
  expect(ranAsPlanned({ model: 'claude-opus-5-5', effort: 'high' }, { model: 'opus', effort: 'high' })).toBe(false)
})


// --- T8 retest (tester): dated ids after the fix ---

test('T8 retest: a dated upstream id confirms its model, a dated sibling does not, Claude ids keep their rule', () => {
  const p = { model: 'gpt-6-astra', effort: 'high' }
  for (const model of ['gpt-6-astra-2026-05-01', 'gpt-6-astra-20260501', 'gpt-6-astra-2026-05-01-high', 'gpt-6-astra-2026-05-01[1m]']) {
    expect(ranAsPlanned(p, { model, effort: 'high' })).toBe(true)
  }
  for (const model of ['gpt-6-astra-mini', 'gpt-6-astra-mini-2026-05-01', 'gpt-6-astra-mini-20260501', 'gpt-6-astra-2026-05', 'gpt-6-astra-202605', 'gpt-6-astra2026-05-01']) {
    expect(ranAsPlanned(p, { model, effort: 'high' })).toBe(false)
  }
  expect(ranAsPlanned(p, { model: 'gpt-6-astra-2026-05-01', effort: 'medium' })).toBe(false)
  expect(ranAsPlanned({ model: 'gpt-6-astra-mini', effort: 'high' }, { model: 'gpt-6-astra-2026-05-01', effort: 'high' })).toBe(false)
  expect(ranAsPlanned({ model: 'opus', effort: 'high' }, { model: 'claude-opus-5-5-20260101', effort: 'high' })).toBe(true)
  expect(ranAsPlanned({ model: 'claude-opus-5-5', effort: 'high' }, { model: 'claude-opus-5-5-20260101', effort: 'high' })).toBe(true)
  expect(ranAsPlanned({ model: 'claude-opus-5-5', effort: 'high' }, { model: 'claude-opus-5-5', effort: 'high' })).toBe(true)
  expect(ranAsPlanned({ model: 'claude-opus-5-5', effort: 'high' }, { model: 'opus', effort: 'high' })).toBe(false)
  expect(ranAsPlanned({ model: 'claude-opus-5-5', effort: 'high' }, { model: 'claude-opus-5-5-1', effort: 'high' })).toBe(false)
  expect(ranAsPlanned({ model: 'sonnet', effort: 'high' }, { model: 'claude-opus-5-5-20260101', effort: 'high' })).toBe(false)
})

// Probe: an effort suffix before the date is not stripped (normalizeModel strips only a trailing effort).
test('T8 retest probe: gpt-6-astra-high-2026-05-01 is reported as a mismatch', () => {
  expect(ranAsPlanned({ model: 'gpt-6-astra', effort: 'high' }, { model: 'gpt-6-astra-high-2026-05-01', effort: 'high' })).toBe(false)
})
