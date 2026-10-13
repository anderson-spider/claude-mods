import { expect, test } from 'claude-code/testing'

test('session start registers the three helpers with their models', async ($, on) => {
  const registered: { name: string; model?: string; effort?: string | number; tools?: readonly string[] }[] = []

  on('agent.register', (_$, e) => (registered.push(e), { value: { agent: `crew:${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

  expect(registered.map(a => [a.name, a.model])).toEqual([
    ['planner', 'opus'],
    ['challenger', 'opus'],
    ['digger', 'haiku'],
  ])
  for (const agent of registered) {
    expect(agent.tools).toContain('Write')
    expect(agent.tools).toContain('Edit')
    expect(agent.tools).not.toContain('Agent')
    expect(agent.effort).toBe('high')
  }
})
