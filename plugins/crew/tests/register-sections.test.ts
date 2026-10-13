import { expect, test } from 'claude-code/testing'
import { KEY, OFF, ON, compose, jevWorld } from './host'

// --- The lead's section ---

test('a request that offers the Agent tool gets the lead section last, naming every specialist', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const composed = await compose($, ['Agent', 'Read'])

  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'crew:lead'])
  const lead = composed.sections.at(-1)
  expect(lead?.scope).toBe('session')
  for (const name of ['code-reader', 'research', 'designer', 'developer', 'architect']) {
    expect(lead?.text).toContain(`crew:${name}`)
  }
  expect(lead?.text).toContain('Jev sizes')
  expect(lead?.text).toContain('Git and pull requests stay with you')
  expect(lead?.text).toContain('For a plan step, start its description with the step id')
  expect(lead?.text).toContain('launch every independent piece with ready inputs in one message')
  expect(lead?.text).toContain('launch newly unblocked or independent work without being asked or waiting for unrelated agents')
  expect(lead?.text).toContain('End each update with one line saying what runs, what waits and on what')
  expect(lead?.text).toContain('done only after crew:architect independently audits it')
  expect(lead?.text).toContain("developer's own commands and output are its report, not acceptance")
  expect(lead?.text).toContain('Send failures to the same developer via SendMessage')
  expect(lead?.text).toContain('after the fix, the architect reaudits before the step closes')
})

test('a request without the Agent tool (a crew agent) gets no lead section', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const composed = await compose($, ['Read', 'Edit'])

  expect(composed.sections.map(section => section.id)).toEqual(['intro'])
})

test('a teammate and a bare prompt get no lead section', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  expect((await compose($, ['Agent'], ['teammate'])).sections.map(section => section.id)).toEqual(['intro'])
  expect((await compose($, ['Agent'], ['bare'])).sections.map(section => section.id)).toEqual(['intro'])
})

test('the lead section reads the same on every request, so the prompt cache holds', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const first = (await compose($, ['Agent'])).sections.at(-1)?.text
  const second = (await compose($, ['Agent'])).sections.at(-1)?.text

  expect(second).toBe(first)
})

test('without a jevKey the lead section does not promise Jev, even with a key in the environment', OFF, async ($, on) => {
  const { seen } = jevWorld(on, { env: { TYPESAFE_API_KEY: KEY, JEV_API_KEY: KEY } })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const text = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

  expect(text).toContain('You orchestrate')
  expect(text).not.toContain('Jev')
  expect(seen.fetches).toEqual([])
})

test('a blank jevKey leaves the lead section without Jev', { options: { jevKey: '   ' } }, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const text = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

  expect(text).toContain('You orchestrate')
  expect(text).not.toContain('Jev')
})
