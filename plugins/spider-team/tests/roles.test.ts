import { expect, test } from 'claude-code/testing'
import { roleOf, ROLES, SPECS } from '../hooks/roles'

test('three read-only roles keep exact fallbacks and permissions, and none writes or runs in a worktree', () => {
  expect(ROLES.map(r => [r, SPECS[r].model, SPECS[r].effort])).toEqual([
    ['analyst', 'haiku', 'high'], ['planner', 'opus', 'medium'], ['reviewer', 'opus', 'medium'],
  ])
  for (const role of ROLES) {
    const spec = SPECS[role]
    expect(roleOf(`spider-team:${role}`)).toBe(role)
    expect(spec).not.toHaveProperty('permissionMode')
    expect(spec).not.toHaveProperty('isolation')
    for (const tool of ['Agent', 'ToolSearch', 'SendMessage', 'Write', 'Edit', 'NotebookEdit']) expect(spec.disallowedTools).toContain(tool)
    for (const tool of ['Write', 'Edit']) expect(spec.tools.includes(tool as never)).toBe(false)
    expect(spec.prompt).toContain('End with a short answer for the lead')
    expect(spec.tools.includes('Bash' as never)).toBe(role === 'reviewer')
  }
  expect(SPECS.reviewer.prompt).toContain('Never edit, commit, stash, checkout or run tests')
})
test('the planner answers with one Markdown plan of steps, files, invariants and acceptance checks, and writes nothing', () => {
  const prompt = SPECS.planner.prompt
  expect(prompt).toContain('without implementing it or writing any file')
  expect(prompt).toContain('Answer with one Markdown plan: goal and scope; ordered steps, each with the files it touches; the invariants to preserve, including authentication, schema and API contracts; an acceptance checklist of commands to run with their expected results; and assumptions or blockers.')
  expect(prompt).toContain('mark anything you could not verify')
})
test('the reviewer judges the lead checkout from the merge base, with uncommitted and untracked files, and blocks what it cannot see', () => {
  const prompt = SPECS.reviewer.prompt
  expect(prompt).toContain('the commits from the merge base with the target branch named in the brief (git merge-base <target> HEAD) to HEAD, the staged and unstaged changes, and every untracked file listed by git status, read in full')
  expect(prompt).toContain('Use read-only git commands only (status, log, diff, show, merge-base, ls-files).')
  expect(prompt).toContain('Judge the complete resulting diff, not only the latest fixes.')
  expect(prompt).toContain('If you cannot inspect any of these parts, answer BLOCKED and say which.')
  expect(prompt).toContain('APPROVED, CHANGES or BLOCKED')
})
test('only exact role names are recognized, and the retired developer and architect are not Spider roles', () => {
  for (const type of ['fork', 'analyst', 'other:analyst', 'spider-team:planner-extra', 'spider-team:developer', 'spider-team:architect', undefined]) expect(roleOf(type)).toBeUndefined()
})
