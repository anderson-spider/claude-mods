import { expect, test } from 'claude-code/testing'
import { EXECUTE, REVIEW, LOOP, JOBS } from '../hooks/schemas'

// Keep these property and required keys in step with McpToolInputs in types/index.d.ts.
test('tool schema keys match the declared tool inputs', () => {
  const inputs = [
    { definition: EXECUTE, properties: ['task', 'files'], required: ['task'] },
    { definition: REVIEW, properties: ['target', 'focus'], required: [] },
    { definition: LOOP, properties: ['task', 'files', 'maxRounds'], required: ['task'] },
    { definition: JOBS, properties: ['id', 'action'], required: [] },
  ]
  for (const { definition, properties, required } of inputs) {
    expect(Object.keys(definition.inputSchema.properties)).toEqual(properties)
    expect('required' in definition.inputSchema ? definition.inputSchema.required : []).toEqual(required)
  }
})
