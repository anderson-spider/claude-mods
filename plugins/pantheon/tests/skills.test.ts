import { expect, test } from 'claude-code/testing'
import { DEFAULTS } from './fixtures/config'
import { buildOrchestratorSection } from '../hooks/prompts/orchestrator'

test('the orchestrator names the four skills and no longer mentions superpowers', () => {
  const section = buildOrchestratorSection(DEFAULTS)
  expect(section).toContain('Invoke the Pantheon skills (grill, execute, debug, finish)')
  expect(section.toLowerCase()).not.toContain('superpowers')
})
