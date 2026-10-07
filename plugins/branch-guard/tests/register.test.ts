import { expect, test } from 'claude-code/testing'

import { BAND, pause, world } from './helpers'

test('commits and pushes on a feature branch or inside /tmp run untouched', async ($, on) => {
  const seen = world(on)

  for (const command of ['ls -la', 'cd /work && git commit -m x', 'cd /tmp/repo && git commit -m x', 'git push --force']) {
    const result = await $.tool.call({ tool: 'Bash', command })

    expect(result.deny).toBeUndefined()
  }

  expect(seen.ran).toHaveLength(4)
})

test('the band holds a commit on main: Cancel refuses it with advice, Proceed runs it', async ($, on) => {
  const seen = world(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    seen.ran.length = 0

    const refused = $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
    await pause(50)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '⚠ Branch Guard · git commit' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'commit 2 files directly on main' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    await ui.press({ key: 'cancel' })

    const denied = (await refused).deny

    expect(denied).toMatch(/pressed Cancel\. It would commit 2 files directly on main\./)
    expect(denied).toMatch(/git switch -c <name>/)
    expect(seen.ran).toEqual([])
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)

    const allowed = $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    await pause(50)
    expect(await ui.find({ type: 'Text', text: 'push 2 commits to origin/main' })).toBeDefined()
    await ui.press({ key: 'proceed' })

    expect((await allowed).deny).toBeUndefined()
    expect(seen.ran).toEqual(['git push origin main'])
    await ui.unmount()
  }
})

test('a push to a protected branch from another branch points to a pull request', async ($, on) => {
  world(on)

  const refused = $.tool.call({ tool: 'Bash', command: 'cd /work && git push origin HEAD:main' })
  await pause(50)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'cancel' })

  expect((await refused).deny).toMatch(/PR/)
  await ui.unmount()
})
