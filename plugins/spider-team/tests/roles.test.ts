import { expect, test } from 'claude-code/testing'
import { capEffort, DIFF, EFFORTS, family, REPORT, roleOf, ROLES, SPECS } from '../hooks/roles'

test('four roles keep exact fallbacks permissions isolation and receipt instructions', () => {
  expect(ROLES.map(r => [r, SPECS[r].model, SPECS[r].effort])).toEqual([
    ['analyst', 'haiku', 'medium'], ['developer', 'sonnet', 'medium'], ['reviewer', 'sonnet', 'high'], ['architect', 'opus', 'high'],
  ])
  for (const role of ROLES) {
    const spec = SPECS[role]
    expect(roleOf(`spider-team:${role}`)).toBe(role)
    expect(spec.tools).toContain(REPORT)
    expect(spec.disallowedTools).toContain('Agent')
    expect(spec).not.toHaveProperty('permissionMode')
    expect(spec).not.toHaveProperty('omitClaudeMd')
    expect(spec).not.toHaveProperty('memory')
    expect(spec.prompt).toContain('copying the receipt returned by the tool verbatim and nothing else')
    if (role === 'developer') {
      expect(spec).toHaveProperty('isolation', 'worktree')
      expect(spec.tools).toContain('Bash'); expect(spec.tools).toContain('Write')
    } else {
      expect(spec).not.toHaveProperty('isolation')
      for (const tool of ['Write', 'Edit', 'Bash', 'Agent', 'ToolSearch', 'SendMessage']) {
        expect(spec.tools).not.toContain(tool); expect(spec.disallowedTools).toContain(tool)
      }
    }
    expect(spec.tools.includes(DIFF as never)).toBe(role === 'reviewer')
  }
})
test('only exact role names and native model families are recognized with effort capped at high', () => {
  for (const type of ['fork', 'analyst', 'other:analyst', 'spider-team:developer-extra', undefined]) expect(roleOf(type)).toBeUndefined()
  for (const value of ['fable', 'inherit', 'claude-fable-5', 'provider/opus', 'opus-latest', 4]) expect(family(value)).toBeUndefined()
  for (const value of ['opus', 'sonnet', 'haiku']) expect(family(value)).toBe(value)
  expect(family('claude-sonnet-4-6')).toBe('sonnet'); expect(family('claude-opus-4.6')).toBe('opus')
  expect(EFFORTS.map(capEffort)).toEqual(['low', 'medium', 'high', 'high', 'high'])
})
