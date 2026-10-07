import { expect, test } from 'claude-code/testing'
import { createPaneLayout } from '../hooks/pane-layout'
import { fakeHerdr } from './helpers'

test('close requires the expected agent and pane in the same list entry', async () => {
  for (const agents of [[], [{ name: 'ct-other', pane: 'w1:p2' }], [{ name: 'ct-1', pane: 'w9:p9' }], [{ name: 'ct-other', pane: 'w1:p2' }, { name: 'ct-1', pane: 'w9:p9' }]]) {
    const layout = createPaneLayout()
    const { herdr, calls } = fakeHerdr({})
    const pane = await layout.open(herdr)
    herdr.list = async () => agents
    expect(await layout.close(herdr, pane, 'ct-1')).toBe('skipped')
    expect(calls.some(call => call.startsWith('close'))).toBe(false)
    await layout.open(herdr)
    expect(calls.filter(call => call.startsWith('split'))).toEqual(['split down', 'split down'])
  }
})

test('close skips a failed list and clears the next split target', async () => {
  const layout = createPaneLayout()
  const { herdr, calls } = fakeHerdr({})
  const pane = await layout.open(herdr)
  herdr.list = async () => { throw new Error('list failed') }
  expect(await layout.close(herdr, pane, 'ct-1')).toBe('skipped')
  await layout.open(herdr)
  expect(calls).toEqual(['split down', 'split down'])
})

test('close closes when both agent and pane match', async () => {
  const layout = createPaneLayout()
  const { herdr, calls } = fakeHerdr({})
  const pane = await layout.open(herdr)
  herdr.list = async () => [{ name: 'ct-1', pane }]
  expect(await layout.close(herdr, pane, 'ct-1')).toBe('closed')
  expect(calls).toContain(`close ${pane}`)
})

test('close skips a pane whose terminal changed, and closes when the terminal matches', async () => {
  const layout = createPaneLayout()
  const { herdr, calls } = fakeHerdr({})
  const pane = await layout.open(herdr)
  herdr.list = async () => [{ name: 'ct-1', pane, terminal: 'term-new' }]
  expect(await layout.close(herdr, pane, 'ct-1', 'term-old')).toBe('skipped')
  expect(calls.some(call => call.startsWith('close'))).toBe(false)
  herdr.list = async () => [{ name: 'ct-1', pane, terminal: 'term-old' }]
  expect(await layout.close(herdr, pane, 'ct-1', 'term-old')).toBe('closed')
  expect(calls).toContain(`close ${pane}`)
})
