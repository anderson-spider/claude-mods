import { expect, test } from 'claude-code/testing'
import { roleOf, ROLES, SPECS } from '../hooks/roles'

test('four roles keep exact fallbacks permissions and isolation', () => {
  expect(ROLES.map(r => [r, SPECS[r].model, SPECS[r].effort])).toEqual([
    ['analyst', 'haiku', 'high'], ['developer', 'sonnet', 'high'], ['reviewer', 'opus', 'medium'], ['architect', 'opus', 'medium'],
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
test('the developer commits locally with Conventional Commits, never pushes or commits on a protected branch, and reports its commits', () => {
  const prompt = SPECS.developer.prompt
  expect(prompt).toContain('Commit your work locally in your worktree as cohesive Conventional Commits in English, with no AI attribution lines.')
  expect(prompt).toContain('Never push.')
  expect(prompt).toContain('Never commit on main, master, develop or any release branch; if your worktree is on one, stop and say so.')
  expect(prompt).toContain('name the absolute worktree path, the branch, the base commit you started from, the SHAs of the commits you created and any uncommitted leftovers')
  expect(prompt).not.toContain('Leave changes uncommitted')
})
test('the reviewer compares the base..HEAD commits and uncommitted changes with read-only git commands only', () => {
  const prompt = SPECS.reviewer.prompt
  expect(prompt).toContain('Review the base..HEAD commit range named in the brief, plus any uncommitted changes in the worktree, with read-only git commands only (status, log, diff, show).')
  expect(prompt).toContain('APPROVED, CHANGES or BLOCKED')
})
test('only exact role names are recognized', () => {
  for (const type of ['fork', 'analyst', 'other:analyst', 'spider-team:developer-extra', undefined]) expect(roleOf(type)).toBeUndefined()
})
