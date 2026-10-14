import { expect, test } from 'claude-code/testing'
import { roleOf, ROLES, SPECS } from '../hooks/roles'

test('four roles keep exact fallbacks permissions and isolation', () => {
  expect(ROLES.map(r => [r, SPECS[r].model, SPECS[r].effort])).toEqual([
    ['analyst', 'sonnet', 'medium'], ['developer', 'sonnet', 'high'], ['reviewer', 'opus', 'low'], ['architect', 'opus', 'medium'],
  ])
  for (const role of ROLES) {
    const spec = SPECS[role]
    expect(roleOf(`spider-team:${role}`)).toBe(role)
    expect(spec).not.toHaveProperty('permissionMode')
    for (const tool of ['Agent', 'ToolSearch', 'SendMessage']) expect(spec.disallowedTools).toContain(tool)
    expect(spec.prompt).toContain('End with a short answer for the lead')
    expect(spec.tools.includes('Bash' as never)).toBe(role === 'developer' || role === 'reviewer')
    for (const tool of ['Write', 'Edit']) expect(spec.tools.includes(tool as never)).toBe(role === 'developer')
    if (role === 'developer') expect(spec).toHaveProperty('isolation', 'worktree')
    else expect(spec).not.toHaveProperty('isolation')
  }
  expect(SPECS.reviewer.prompt).toContain('Never edit, commit, stash, checkout or run tests')
})
test('only exact role names are recognized', () => {
  for (const type of ['fork', 'analyst', 'other:analyst', 'spider-team:developer-extra', undefined]) expect(roleOf(type)).toBeUndefined()
})
