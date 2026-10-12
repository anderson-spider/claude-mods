import { expect, test } from 'claude-code/testing'
import { SPECIALISTS } from '../hooks/agents'
import { TOOL_SCHEMAS, describable } from '../hooks/codex-tools'

test('crew describes Read, Glob and Grep, each an object schema with its required fields and nothing else allowed', () => {
  expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual(['Glob', 'Grep', 'Read'])
  expect(TOOL_SCHEMAS.Read?.required).toEqual(['file_path'])
  expect(TOOL_SCHEMAS.Glob?.required).toEqual(['pattern'])
  expect(TOOL_SCHEMAS.Grep?.required).toEqual(['pattern'])
  for (const schema of Object.values(TOOL_SCHEMAS)) {
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    for (const field of schema.required) expect(Object.keys(schema.properties)).toContain(field)
  }
})

test('only a role whose every tool has a schema can run on the login: today the code-reader alone', () => {
  expect(SPECIALISTS.filter(role => describable(role.tools)).map(role => role.name)).toEqual(['code-reader'])
  expect(describable([])).toBe(false)
  expect(describable(['Read', 'Bash'])).toBe(false)
})
