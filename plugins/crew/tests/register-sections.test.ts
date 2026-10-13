import { expect, test } from 'claude-code/testing'
import { KEY, OFF, ON, compose, jevWorld } from './host'

// --- The main session's section ---

test('a request that offers the Agent tool gets the main section last, naming every specialist', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const composed = await compose($, ['Agent', 'Read'])

  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'crew:main'])
  const main = composed.sections.at(-1)
  expect(main?.scope).toBe('session')
  for (const name of ['planner', 'challenger', 'digger']) {
    expect(main?.text).toContain(`crew:${name}`)
  }
  expect(main?.text).toContain('Jev sizes')
  expect(main?.text).toContain('You are the main session: you implement')
  expect(main?.text).toContain('For a plan step, start its description with the step id')
  for (const gone of ['crew:developer', 'crew:architect', 'audit', 'SendMessage']) expect(main?.text).not.toContain(gone)
})

test('a request without the Agent tool (a crew agent) gets no main section', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const composed = await compose($, ['Read', 'Edit'])

  expect(composed.sections.map(section => section.id)).toEqual(['intro'])
})

test('a teammate and a bare prompt get no main section', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  expect((await compose($, ['Agent'], ['teammate'])).sections.map(section => section.id)).toEqual(['intro'])
  expect((await compose($, ['Agent'], ['bare'])).sections.map(section => section.id)).toEqual(['intro'])
})

test('the main section reads the same on every request, so the prompt cache holds', ON, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const first = (await compose($, ['Agent'])).sections.at(-1)?.text
  const second = (await compose($, ['Agent'])).sections.at(-1)?.text

  expect(second).toBe(first)
})

test('without a jevKey the main section does not promise Jev, even with a key in the environment', OFF, async ($, on) => {
  const { seen } = jevWorld(on, { env: { TYPESAFE_API_KEY: KEY, JEV_API_KEY: KEY } })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const text = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

  expect(text).toContain('You are the main session')
  expect(text).not.toContain('Jev')
  expect(seen.fetches).toEqual([])
})

test('a blank jevKey leaves the main section without Jev', { options: { jevKey: '   ' } }, async ($, on) => {
  jevWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const text = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

  expect(text).toContain('You are the main session')
  expect(text).not.toContain('Jev')
})
