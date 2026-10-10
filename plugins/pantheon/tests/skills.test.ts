import { expect, test } from 'claude-code/testing'
import { DEFAULTS } from './fixtures/config'
import { buildLeadSection } from '../hooks/prompts/lead'

test('the lead names the four skills and no longer mentions superpowers', () => {
  const section = buildLeadSection(DEFAULTS)
  expect(section).toContain('Invoke the Pantheon skills (grill, execute, debug, finish)')
  expect(section.toLowerCase()).not.toContain('superpowers')
})
