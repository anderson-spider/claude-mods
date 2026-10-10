import { expect, test } from 'claude-code/testing'
import { DEFAULTS } from './fixtures/config'
import { buildLeadSection } from '../hooks/prompts/lead'
import { parseFlow } from '../hooks/jevflow/flow'
import { planInstructions } from '../hooks/jevflow/texts'

test('the lead names the three skills and no longer mentions superpowers', () => {
  const section = buildLeadSection(DEFAULTS)
  expect(section).toContain('Invoke the Pantheon skills (flow, brainstorm, goal, debug, finish)')
  expect(section.toLowerCase()).not.toContain('superpowers')
})

test('the example flow in the planning instructions is accepted by the flow contract', () => {
  const text = planInstructions('.pantheon/flow/flows/x/flow.json', 'x', 'Add a dark mode toggle')
  const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1]
  if (!json) throw new Error('no example in the planning instructions')
  const result = parseFlow(JSON.parse(json))
  if (!result.ok) throw new Error(result.errors.join('; '))
  expect(result.flow.phases.map(p => p.id)).toEqual(['implement', 'docs'])
  expect(result.flow.phases[1]?.depends_on).toEqual(['implement'])
})
