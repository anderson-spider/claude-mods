import { expect, test } from 'claude-code/testing'
import { MIXED } from './fixtures/profiles'
import { buildOrchestratorSection } from '../hooks/prompts/orchestrator'

test('the orchestrator names the four skills and no longer mentions superpowers', () => {
  const section = buildOrchestratorSection(MIXED)
  for (const name of ['grill', 'execute', 'debug', 'finish']) expect(section).toContain(name)
  expect(section.toLowerCase()).not.toContain('superpowers')
})
