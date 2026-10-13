import { expect, test } from 'claude-code/testing'
import { codexEffort, failedStep, handbackStep, textStep } from '../hooks/codex'

test('a failed step is one text block and an end_turn stop with no usage', () => {
  expect(failedStep('no login')).toEqual({
    chunks: [{ kind: 'text', index: 0, text: 'crew: this Codex twin could not run: no login.' }, { kind: 'stop', stopReason: 'end_turn', usage: null }],
    answer: 'crew: this Codex twin could not run: no login.',
    toolUses: [],
    stopReason: 'end_turn',
    usage: null,
  })
})

test('an effort outside the twins\' levels falls back to the default', () => {
  expect(codexEffort('high', 'medium')).toBe('high')
  expect(codexEffort('xhigh', 'medium')).toBe('xhigh')
  for (const other of ['max', 'ultra', '7', undefined]) expect(codexEffort(other, 'medium')).toBe('medium')
})

test('handback preserves the helper answer in its tool call with no usage', () => {
  const step = handbackStep(textStep('found it'), 'handback_1')
  expect(step).toEqual({
    chunks: [
      { kind: 'tool', index: 0, id: 'handback_1', name: 'SubagentHandback' },
      { kind: 'input', index: 0, json: '{"message":"found it"}' },
      { kind: 'stop', stopReason: 'tool_use', usage: null },
    ],
    answer: '', toolUses: [{ name: 'SubagentHandback', input: { message: 'found it' } }],
    stopReason: 'tool_use', usage: null,
  })
})
