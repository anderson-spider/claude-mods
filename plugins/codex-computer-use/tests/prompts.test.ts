import { expect, test } from 'claude-code/testing'

import { DESCRIPTION, PROMPT, denyOwn } from '../hooks/prompts'

test('prompt budget: the fixed text stays lean and the first-call rule lives in the description', () => {
  const prompt = PROMPT('mcp__codex-computer-use__codex_cu')
  expect(prompt.length).toBeLessThanOrEqual(1800)
  expect(DESCRIPTION.length).toBeLessThanOrEqual(DESCRIPTION_BUDGET)
  expect(DESCRIPTION).toContain('cua.getState()')
  expect(prompt).not.toContain('cua.getState()')
  expect(denyOwn('mcp__codex-computer-use__codex_cu')).toContain('mcp__codex-computer-use__codex_cu')
})

const DESCRIPTION_BUDGET = 520
