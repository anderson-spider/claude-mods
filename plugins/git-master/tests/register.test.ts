import { expect, test } from 'claude-code/testing'
import { GIT_MASTER } from '../hooks/agent'
import { started, world } from './host'

test('session start registers git-master on Haiku, for any request about git', async ($, on) => {
  const { agents } = world(on)
  await started($)

  expect(agents.map(agent => agent.name)).toEqual(['git-master'])
  expect(agents[0]?.model).toBe('haiku')
  expect(agents[0]?.description).toContain('whenever the request is about git')
})

test('git-master works through git and conflict fixes only, and never delegates', () => {
  expect([...GIT_MASTER.tools].sort()).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read'])
  for (const tool of ['Write', 'Agent', 'NotebookEdit']) expect(GIT_MASTER.tools).not.toContain(tool)
})

test('its prompt keeps the session rules, lease-guarded rewrites, human authorship and a stop before losing work', () => {
  for (const rule of ["Follow the git rules in the session's instructions", '`--force-with-lease`', 'never an AI tool or assistant', 'check what would be lost', 'Conventional Commits in English']) {
    expect(GIT_MASTER.prompt).toContain(rule)
  }
})
