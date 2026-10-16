import { expect, test } from 'claude-code/testing'

import { DESCRIPTION, PROMPT, denyOwn } from '../hooks/prompts'

test('prompt budget: the fixed text stays lean and the first-call rule lives in the description', () => {
  const prompt = PROMPT('mcp__codex-computer-use__codex_cu')
  expect(prompt.length).toBeLessThanOrEqual(1500)
  expect(DESCRIPTION.length).toBeLessThanOrEqual(DESCRIPTION_BUDGET)
  expect(DESCRIPTION).toContain('cua.getState()')
  expect(prompt).not.toContain('cua.getState()')
  expect(denyOwn('mcp__codex-computer-use__codex_cu')).toContain('mcp__codex-computer-use__codex_cu')
})

test('denyOwn is pinned byte for byte', () => {
  expect(denyOwn('mcp__codex-computer-use__codex_cu')).toBe(
    'codex-computer-use is on: use mcp__codex-computer-use__codex_cu for native apps. Report bridge failures; do not switch desktop-control routes. ' +
      'The person can type /codex-cu off to restore this tool.',
  )
})

test('routing instructions keep consent, fresh state and private-input guardrails', () => {
  const prompt = PROMPT('bridge')
  expect(prompt).toContain('re-read after each action')
  expect(prompt).toContain('read state before retrying')
  expect(prompt).toContain('least-change option for dialogs')
  expect(prompt).toContain('app refusal or an organization/safety block')
  expect(prompt).toContain('never bypass it through another desktop-control route')
  expect(prompt).toContain('passwords and payment details to the person; never type them')
  expect(prompt).toContain('Share private screen content only when the task needs it')
  expect(denyOwn('bridge')).toContain('Report bridge failures; do not switch desktop-control routes')
  expect(DESCRIPTION).toContain('First call after start/reset: one documented entry call')
  expect(DESCRIPTION).toContain('read its API documentation before continuing')
})

const DESCRIPTION_BUDGET = 460
