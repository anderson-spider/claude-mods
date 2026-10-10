import { expect, test } from 'claude-code/testing'
import { DEFAULTS } from './fixtures/config'
import { buildLeadSection } from '../hooks/prompts/lead'
import { extractBlock, parseFlow } from '../hooks/flow/plan'

// `claude plugin test` has no file system and cannot import Markdown, so skills/brainstorm/SKILL.md is out of reach:
// this is the example block copied from it verbatim. Change one, change the other.
const BRAINSTORM_EXAMPLE = `{
  "schemaVersion": 1,
  "planId": "csv-export",
  "goal": "Users can export the report table as CSV from the toolbar.",
  "limits": { "maxBlocks": 6, "maxAttempts": 2 },
  "tasks": [
    {
      "id": "T1",
      "goal": "Add the CSV serializer; cells starting with = + - or @ are escaped.",
      "files": ["src/export/csv.ts", "tests/csv.test.ts"],
      "role": "developer",
      "dependsOn": [],
      "acceptance": { "checks": [{ "argv": ["npm", "test", "--", "csv"], "timeoutSec": 120 }] },
      "risk": true,
      "sideEffect": false
    },
    {
      "id": "T2",
      "goal": "Add the Export button to the toolbar.",
      "files": ["src/ui/Toolbar.tsx", "tests/toolbar.test.tsx"],
      "role": "ux",
      "dependsOn": ["T1"],
      "acceptance": {
        "checks": [{ "argv": ["npm", "test", "--", "toolbar"], "timeoutSec": 120 }],
        "criteria": ["The Export button sits at the right end of the toolbar and downloads report.csv with the visible rows."]
      },
      "risk": false,
      "sideEffect": false
    },
    {
      "id": "T3",
      "goal": "Document the export.",
      "files": ["docs/export.md"],
      "role": "developer",
      "dependsOn": ["T1"],
      "acceptance": { "checks": [{ "argv": ["grep", "-q", "report.csv", "docs/export.md"], "timeoutSec": 10 }] },
      "risk": false,
      "sideEffect": false
    }
  ]
}`

const fenced = (json: string) => `# Plan\n\n## Flow\n\n\`\`\`pantheon-flow\n${json}\n\`\`\`\n`

test('the lead names the four skills and no longer mentions superpowers', () => {
  const section = buildLeadSection(DEFAULTS)
  expect(section).toContain('Invoke the Pantheon skills (brainstorm, execute, debug, finish)')
  expect(section.toLowerCase()).not.toContain('superpowers')
})

test('the example flow block in brainstorm is accepted by the flow contract', () => {
  const plan = fenced(BRAINSTORM_EXAMPLE)
  expect('json' in extractBlock(plan)).toBe(true)
  const result = parseFlow(plan)
  if (!result.ok) throw new Error(result.errors.join('; '))
  const [serializer, button, docs] = result.flow.tasks
  // It shows a check-only risk task, a ux task with a criterion, and two tasks that run together after the first.
  expect(result.flow.tasks.map(task => task.role)).toEqual(['developer', 'ux', 'developer'])
  expect(serializer).toMatchObject({ risk: true, dependsOn: [] })
  expect(serializer.acceptance.criteria).toEqual([])
  expect(button.acceptance.checks.length).toBeGreaterThan(0)
  expect(button.acceptance.criteria.length).toBeGreaterThan(0)
  expect(button.dependsOn).toEqual(['T1'])
  expect(docs.dependsOn).toEqual(['T1'])
  expect(button.files.some(file => docs.files.includes(file))).toBe(false)
  for (const task of result.flow.tasks) for (const check of task.acceptance.checks) expect(Array.isArray(check.argv)).toBe(true)
})
