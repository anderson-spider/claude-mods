import { expect, test } from 'claude-code/testing'
import {
  HOME, KEY, OFF, ON, ROOT, TOKEN, answer, compose, jevWorld, notRouted, ok, pause, record, rejected, shape,
  spawnInput, step, traced,
} from './host'
import type { Reply } from './host'

// --- Jev routing ---

test('Jev sets only effort and never rewrites a Claude model or type, with the key in the header only', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]).toMatchObject({ subagentType: 'crew:digger' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.fetches.length).toBe(1)
  expect(seen.fetches[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(seen.fetches[0]?.headers.Authorization).toBe(`Bearer ${KEY}`)
  const body = JSON.parse(seen.fetches[0]?.body ?? '{}')
  expect(body.model).toBe('jev-1.13.0')
  expect(body.state.agent).toEqual({ type: 'digger', description: 'audit auth' })
  expect(Object.keys(body.questions)).toEqual(['reasoning_depth'])
  expect(seen.notices).toEqual(['crew:digger -> haiku · medium (jev)'])
  expect(seen.logs.some(line => line.includes('model=haiku (default)') && line.includes('jev=jev-1.13.0'))).toBe(true)
  expect(JSON.stringify([seen.notices, seen.logs])).not.toContain(KEY)
})

test('a filled jevKey turns routing on: a crew call is sent and its task shows the choice', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())

  expect(seen.fetches.length).toBe(1)
  expect(seen.spawned[0]).toMatchObject({ description: 'audit auth · haiku/medium' })
})

test('the task shows a kept choice too', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer(4.6)) })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]?.description).toBe('audit auth · haiku/high')
})

test('a call Jev failed on shows its fixed model and high fallback', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok('not json') })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]?.description).toBe('audit auth · haiku/high')
})

test('a description that already carries a tag is sent without it and tagged once', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput({ description: 'audit auth · haiku/low' }))

  expect(JSON.parse(seen.fetches[0]?.body ?? '{}').state.agent.description).toBe('audit auth')
  expect(seen.spawned[0]?.description).toBe('audit auth · haiku/medium')
})

test('an agent the list shows without the tag does not take the routed effort', ON, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer(2.1)),
    agents: [{ id: 'a9', type: 'crew:digger', description: 'audit auth' }],
    spawn: async () => { await held; return { model: 'default', agentId: 'a1' } },
  })
  const spawned = $.agent.spawn(spawnInput())
  while (seen.spawned.length === 0) await pause()
  await step($, 'a9', 'high')
  release()
  await spawned

  expect(seen.steps).toEqual(['high'])
})

test('a decision that matches the defaults rewrites nothing', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer(4.6)) })
  await $.agent.spawn(spawnInput())

  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.notices).toEqual(['crew:digger -> haiku · high (jev)'])
})

test('a call that names a model, a fork, a workflow agent and non-crew types are untouched and never sent', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer(5.6)) })
  await $.agent.spawn(spawnInput({ model: 'haiku' }))
  await $.agent.spawn(spawnInput({ fork: true }))
  await $.agent.spawn(spawnInput({ workflow: { runId: 'wf_1', agentIndex: 1 } }))
  for (const subagentType of ['general-purpose', 'Explore', 'other:digger', 'crew:unknown']) {
    await $.agent.spawn(spawnInput({ subagentType }))
  }

  expect(seen.fetches).toEqual([])
  expect(seen.notices).toEqual([])
  expect(seen.spawned.map(s => s.model)).toEqual(['haiku', undefined, undefined, undefined, undefined, undefined, undefined])
  expect(seen.spawned.map(s => s.subagentType)).toEqual(['crew:digger', 'crew:digger', 'crew:digger', 'general-purpose', 'Explore', 'other:digger', 'crew:unknown'])
  // No effort either: the workflow agent's steps run on what they came with.
  await step($, 'a1', 'high')
  expect(seen.steps).toEqual(['high'])
})

test('without a jevKey nothing is sent and no settings are read, even with a key in the environment or in the key file', OFF, async ($, on) => {
  const { seen } = jevWorld(on, { env: { TYPESAFE_API_KEY: KEY, JEV_API_KEY: KEY }, files: { [`${HOME}/.jev-router.env`]: `JEV_API_KEY=${KEY}\n` } })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')

  expect(seen.fetches).toEqual([])
  expect(seen.settingsReads).toBe(0)
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.logs.filter(line => line.includes('routing is off'))).toEqual([])
})

test('an empty or blank jevKey is off silently', { options: { jevKey: '   ' } }, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())

  expect(seen.fetches).toEqual([])
  expect(seen.logs.filter(line => line.includes('routing is off'))).toEqual([])
})

test('a malformed jevKey is off with one debug line that never shows it', { options: { jevKey: 'two words' } }, async ($, on) => {
  const { seen } = jevWorld(on)
  await $.agent.spawn(spawnInput())
  await $.agent.spawn(spawnInput())

  expect(seen.fetches).toEqual([])
  expect(seen.spawned.map(s => s.model)).toEqual([undefined, undefined])
  expect(seen.logs.filter(line => line.includes('routing is off'))).toEqual(['crew jev: routing is off: the jevKey option is not a valid key'])
  expect(JSON.stringify([seen.logs, seen.notices])).not.toContain('two words')
})

test('the jevKey option is the only source of the key', ON, async ($, on) => {
  const { seen } = jevWorld(on, { env: { TYPESAFE_API_KEY: 'other-key-from-env', JEV_API_KEY: 'another-key-from-env' } })
  await $.agent.spawn(spawnInput())

  expect(seen.fetches[0]?.headers.Authorization).toBe(`Bearer ${KEY}`)
  expect(seen.spawned[0]?.model).toBeUndefined()
})

test('settings that cannot be read disable Jev requests and use high, and the log says why', ON, async ($, on) => {
  const { seen } = jevWorld(on, { settingsFail: true })
  await $.agent.spawn(spawnInput())

  expect(seen.fetches).toEqual([])
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.logs.some(line => line.includes('routing is off') && line.includes('cannot be read'))).toBe(true)
  expect(JSON.stringify(seen.logs)).not.toContain(KEY)
})

test('a HOME that the repository settings declare keeps routing on but leaves the decision log unwritten', ON, async ($, on) => {
  const { seen } = jevWorld(on, { project: { env: { HOME } } })
  await $.agent.spawn(spawnInput())

  expect(seen.fetches).toHaveLength(1)
  expect(seen.writes).toEqual([])
})

test('a HOME that the repository declares is not used by redaction either', ON, async ($, on) => {
  const { seen } = jevWorld(on, { project: { env: { HOME: '.' } } })
  await $.agent.spawn(spawnInput({ prompt: `Check /Users/maria/work/secret-app/src/a.ts and ${HOME}/work/x.ts` }))

  // The user's key is the option, so the call is sent; the home it would trust is not the repository's.
  const body = seen.fetches[0]?.body ?? ''
  expect(body).not.toContain('/Users/maria')
  expect(body).not.toContain(`${HOME}/work`)
})

test('without a trusted home the username still goes: it is taken from the session directory', ON, async ($, on) => {
  const { seen } = jevWorld(on, { cwd: '/Users/maria/work/app', project: { env: { HOME: '/srv/elsewhere' } } })
  const prompt = 'See -Users-maria-work-app-x and the prompt "maria@Mac % ls", Author: maria, /Users/maria/notes/todo.md'
  await $.agent.spawn(spawnInput({ prompt, description: 'check maria prompt' }))

  const body = seen.fetches[0]?.body ?? ''
  expect(body).toContain('state')
  expect(body).not.toContain('maria')
  // The repository's own HOME is not the stand-in.
  expect(body).not.toContain('/srv/elsewhere')
})

test('a settings read that fails after the key was cached does not cost the redaction its home', ON, async ($, on) => {
  const { seen, flags } = jevWorld(on)
  await $.agent.spawn(spawnInput())
  flags.settingsFail = true
  await $.agent.spawn(spawnInput({ prompt: `Open ${HOME}/work/a.ts, owner u, -home-u-work-x`, description: 'second' }))

  expect(seen.fetches.length).toBe(2)
  const body = seen.fetches[1]?.body ?? ''
  expect(body).not.toContain(`${HOME}/work`)
  expect(body).not.toContain('-home-u-work')
  // Not re-read per spawn: one resolution served both calls.
  expect(seen.logs.filter(line => line.includes('routing is off'))).toEqual([])
})

test('two calls alike, one routed and one that Jev failed on, are told apart by the tag', ON, async ($, on) => {
  let held = true
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let fetched = 0
  let spawned = 0
  const { seen } = jevWorld(on, {
    reply: async () => (fetched++ === 0 ? ok(answer(2.1)) : { status: 400, ok: false, headers: {}, text: '{}' }),
    agents: [
      // The host lists each with the description it was spawned with: the routed one carries the tag.
      { id: 'a1', type: 'crew:digger', description: 'fix tests · haiku/medium' },
      { id: 'a2', type: 'crew:digger', description: 'fix tests · haiku/high' },
    ],
    spawn: async () => {
      const agentId = `a${++spawned}`
      while (held) await gate
      return { model: 'default', agentId }
    },
  })

  const both = [
    $.agent.spawn(spawnInput({ description: 'fix tests', tool_use_id: 'tu1' })),
    $.agent.spawn(spawnInput({ description: 'fix tests', tool_use_id: 'tu2' })),
  ]
  while (seen.spawned.length < 2) await pause()
  // Both subagents step before either spawn resolves.
  await step($, 'a1', 'high')
  await step($, 'a2', 'high')
  held = false
  release()
  await Promise.all(both)
  await step($, 'a1', 'high')
  await step($, 'a2', 'high')

  // Both run on their tagged effort from the first step: medium answer and high fallback.
  expect(seen.steps).toEqual(['medium', 'high', 'medium', 'high'])
  expect(seen.notices.some(text => text.includes('not applied'))).toBe(false)
})

test('a jevKey that the repository declares is ignored, and the log says why', ON, async ($, on) => {
  const repo = jevWorld(on, {
    project: { pluginConfigs: { 'crew@spider-claude-mods': { options: { jevKey: KEY } } } },
  })
  await $.agent.spawn(spawnInput())

  expect(repo.seen.fetches).toEqual([])
  expect(repo.seen.logs.some(line => line.includes('routing is off') && line.includes('jevKey'))).toBe(true)
})

const declared = (plugin: string) => ({ pluginConfigs: { [plugin]: { options: { jevKey: 'repo-key-123' } } } })

for (const [source, plugin] of [
  ['project', 'crew@inline'], ['project', 'crew@spider-claude-mods'],
  ['local', 'crew@inline'], ['local', 'crew@spider-claude-mods'],
] as const) {
  test(`a jevKey declared by ${source} settings for ${plugin} turns routing off: no fetch, high fallback, no Jev wording`, ON, async ($, on) => {
    const { seen } = jevWorld(on, { [source]: declared(plugin) })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
    const result = await $.agent.spawn(spawnInput())
    const lead = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

    expect(seen.fetches).toEqual([])
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(String(seen.spawned[0]?.description)).toBe('audit auth · haiku/high')
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(seen.logs.some(line => line.includes('routing is off') && line.includes('jevKey'))).toBe(true)
    expect(JSON.stringify([seen.logs, seen.notices])).not.toContain(KEY)
    expect(lead).not.toContain('Jev')
  })
}

test('unreadable settings with a valid key: no fetch, high fallback, no Jev wording', ON, async ($, on) => {
  const { seen } = jevWorld(on, { settingsFail: true })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  await $.agent.spawn(spawnInput())
  const lead = (await compose($, ['Agent'])).sections.at(-1)?.text ?? ''

  expect(seen.fetches).toEqual([])
  expect(String(seen.spawned[0]?.description)).toBe('audit auth · haiku/high')
  expect(lead).not.toContain('Jev')
})

for (const [label, bad] of [
  ['a newline', `${KEY}\nextra`],
  ['a tab', `${KEY}\textra`],
  ['over 512 characters', 'k'.repeat(513)],
] as const) {
  test(`a jevKey with ${label} sends nothing and never reaches a log or notice`, { options: { jevKey: bad } }, async ($, on) => {
    const { seen } = jevWorld(on)
    await $.agent.spawn(spawnInput())

    expect(seen.fetches).toEqual([])
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(seen.logs.filter(line => line.includes('routing is off'))).toEqual(['crew jev: routing is off: the jevKey option is not a valid key'])
    const out = JSON.stringify([seen.logs, seen.transcript, seen.notices])
    expect(out).not.toContain(bad.slice(0, 20))
    expect(out).not.toContain(KEY)
  })
}

test('an error status, a malformed body and a thrown fetch keep the model fixed and request high', ON, async ($, on) => {
  const replies: (() => Promise<Reply>)[] = [
    async () => ({ status: 401, ok: false, headers: {}, text: `denied for ${KEY}` }),
    async () => ok('<html>'),
    async () => { throw new Error(`connection reset, Bearer ${KEY}`) },
  ]
  let next = 0
  const { seen, clock } = jevWorld(on, { reply: () => replies[next++ % replies.length]!() })

  await $.agent.spawn(spawnInput())
  await $.agent.spawn(spawnInput())
  // A dropped connection is retried once after a short pause, inside the deadline.
  const dropped = $.agent.spawn(spawnInput())
  while (next < 3) await pause()
  await clock.advance(300)
  await dropped

  expect(seen.spawned.map(s => s.model)).toEqual([undefined, undefined, undefined])
  expect(seen.notices).toEqual(Array.from({ length: 3 }, () => 'crew:digger -> haiku · high'))
  expect(JSON.stringify(seen.logs)).not.toContain(KEY)
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['high'])
})

test('a Jev that does not answer in time leaves the model fixed and requests high', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: () => new Promise<Reply>(() => {}) })
  const spawned = $.agent.spawn(spawnInput())
  await clock.settle()
  await pause()
  await clock.advance(3_000)
  await spawned

  expect(seen.fetches.length).toBe(1)
  expect(seen.spawned[0]?.model).toBeUndefined()
})

test('the prompt reaches Jev redacted and cut: no token, no home path', ON, async ($, on) => {
  const { seen } = jevWorld(on)
  const prompt = [
    `Fix ${HOME}/work/secret-app/src/a.ts with the token ${TOKEN}`,
    `Authorization: Bearer ${TOKEN}`,
    `${ROOT}/src/b.ts`,
    'x'.repeat(10_000),
  ].join('\n')
  await $.agent.spawn(spawnInput({ prompt, description: `use ${TOKEN}` }))

  const body = seen.fetches[0]?.body ?? ''
  expect(body).not.toContain(TOKEN)
  expect(body).not.toContain(KEY)
  expect(body).not.toContain(`${HOME}/work`)
  expect(body).toContain('src/b.ts')
  const sent = JSON.parse(body).state.task.prompt as string
  expect(sent.length).toBeLessThanOrEqual(4001)
})

test('at most four Jev calls run at once; the fifth spawn uses high without another request', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: () => new Promise<Reply>(() => {}) })
  const first = Array.from({ length: 4 }, () => $.agent.spawn(spawnInput()))
  await clock.settle()
  await pause()
  expect(seen.fetches.length).toBe(4)

  const fifth = await $.agent.spawn(spawnInput())
  expect(seen.fetches.length).toBe(4)
  expect(fifth).toMatchObject({ model: 'default' })

  await clock.advance(3_000)
  await Promise.all(first)
  expect(seen.spawned.length).toBe(5)
})

test('the effort follows the spawn id on the subagent\'s steps, only when it differs from the default', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok(answer(2.1)) })
  await $.agent.spawn(spawnInput())

  await step($, 'a1', 'high')
  await step($, 'other', 'high')
  await step($, undefined, 'high')
  await step($, 'a1', null)

  expect(seen.steps).toEqual(['medium', 'high', 'high', undefined])
})

test('a step that arrives before the spawn resolves still gets the effort', ON, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer(2.1)),
    agents: [{ id: 'a1', type: 'crew:digger', description: 'audit auth · haiku/medium' }],
    spawn: async () => { await held; return { model: 'default', agentId: 'a1' } },
  })

  const spawned = $.agent.spawn(spawnInput())
  while (seen.spawned.length === 0) await pause()
  // The subagent started and stepped; the spawn call has not resolved yet.
  await step($, 'a1', 'high')
  release()
  await spawned
  await step($, 'a1', 'high')

  expect(seen.steps).toEqual(['medium', 'medium'])
})

test('an effort that was not known at the first step is not applied later: the agent keeps the default for its run', ON, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  // The agent is not listed yet when it steps first.
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer(2.1)),
    spawn: async () => { await held; return { model: 'default', agentId: 'a1' } },
  })

  const spawned = $.agent.spawn(spawnInput())
  while (seen.spawned.length === 0) await pause()
  await step($, 'a1', 'high')
  release()
  await spawned
  await step($, 'a1', 'high')
  await step($, 'a1', 'high')

  expect(seen.steps).toEqual(['high', 'high', 'high'])
  // The notice and the debug line say what runs, not what Jev asked for.
  expect(seen.notices).toEqual(['crew:digger -> haiku · effort unknown (jev; effort medium not applied)'])
  expect(seen.logs.some(line => line.includes('effort=unknown'))).toBe(true)
  expect(seen.logs.some(line => line.includes('effort medium not applied (stepped)'))).toBe(true)
})

test('a spawn that the host refuses reaches the caller and leaves no effort behind', ON, async ($, on) => {
  const { seen } = jevWorld(on, {
    reply: async () => ok(answer(2.1)),
    spawn: async () => ({ deny: 'spawn refused' }) as never,
    agents: [{ id: 'a1', type: 'crew:digger', description: 'audit auth' }],
  })

  expect(await $.agent.spawn(spawnInput())).toEqual({ deny: 'spawn refused' })
  await step($, 'a1', 'high')

  expect(seen.fetches.length).toBe(1)
  expect(seen.steps).toEqual(['high'])
  // Nothing started, so nothing is announced.
  expect(seen.notices).toEqual([])
})

test('a Jev failure pins Claude effort to high, even when the host sends medium or xhigh', ON, async ($, on) => {
  const { seen } = jevWorld(on, {
    // A 400 is not retried, so no timer is waited on.
    reply: async () => ({ status: 400, ok: false, headers: {}, text: '{}' }),
    agents: [{ id: 'a1', type: 'crew:digger', description: 'audit auth' }],
  })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'medium')
  await step($, 'a1', 'xhigh')

  expect(seen.steps).toEqual(['high', 'high'])
  expect(seen.notices).toEqual(['crew:digger -> haiku · high'])
})

test('the main loop and an agent that was not routed step untouched, and routing off leaves steps alone', OFF, async ($, on) => {
  const { seen } = jevWorld(on, { agents: [{ id: 'a1', type: 'crew:digger', description: 'audit auth' }] })
  await step($, 'a1', 'high')
  await step($, undefined, 'medium')

  expect(seen.steps).toEqual(['high', 'medium'])
})

// --- The entry module's observable order and log lines, pinned ---

// The debug line of a call that Jev failed on: the reason, and the status when the failure has one. Nothing else of
// the failure (message, body, key) reaches it; the caller requests high.

test('an error status is logged as its reason and status, and Claude requests high', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => rejected(401) })
  const result = await $.agent.spawn(spawnInput())

  expect(notRouted(seen)).toEqual(['crew jev: crew:digger not routed (http 401)'])
  expect(seen.fetches).toHaveLength(1)
  expect(result).toMatchObject({ model: 'default', agentId: 'a1' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(seen.notices).toEqual(['crew:digger -> haiku · high'])
  expect(record(seen)).toMatchObject({ v: 4, effortPlanned: 'high', effortApplied: 'high', jevModel: null })
  await step($, 'a1', 'medium')
  expect(seen.steps).toEqual(['high'])
})

test('a status that is retried is logged after its one retry, with the status of the last attempt', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: async () => rejected(503) })
  const spawned = $.agent.spawn(spawnInput())
  while (seen.fetches.length === 0) await pause()
  await clock.advance(300)
  await spawned

  expect(seen.fetches).toHaveLength(2)
  expect(notRouted(seen)).toEqual(['crew jev: crew:digger not routed (http 503)'])
})

test('a malformed body is logged by its reason alone, with no status', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => ok('<html>') })
  await $.agent.spawn(spawnInput())

  expect(notRouted(seen)).toEqual(['crew jev: crew:digger not routed (malformed)'])
  expect(seen.fetches).toHaveLength(1)
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['high'])
})

test('a deadline that passes is logged as timeout, with no status', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: () => new Promise<Reply>(() => {}) })
  const spawned = $.agent.spawn(spawnInput())
  await clock.settle()
  await pause()
  await clock.advance(3_000)
  await spawned

  expect(notRouted(seen)).toEqual(['crew jev: crew:digger not routed (timeout)'])
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['high'])
})

test('a connection that keeps dropping is logged as network, with no status, after its one retry', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: async () => { throw new Error(`connection reset, Bearer ${KEY}`) } })
  const spawned = $.agent.spawn(spawnInput())
  while (seen.fetches.length === 0) await pause()
  await clock.advance(300)
  await spawned

  expect(seen.fetches).toHaveLength(2)
  expect(notRouted(seen)).toEqual(['crew jev: crew:digger not routed (network)'])
  expect(JSON.stringify(seen.logs)).not.toContain(KEY)
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['high'])
})

test('a fifth concurrent call is logged as busy at once, and the four in flight as timeout later', ON, async ($, on) => {
  const { seen, clock } = jevWorld(on, { reply: () => new Promise<Reply>(() => {}) })
  const first = Array.from({ length: 4 }, () => $.agent.spawn(spawnInput()))
  await clock.settle()
  await pause()
  await $.agent.spawn(spawnInput())

  await step($, 'a1', 'medium')
  expect(seen.steps).toEqual(['high'])
  expect(notRouted(seen)).toEqual(['crew jev: crew:digger not routed (busy)'])
  expect(seen.fetches).toHaveLength(4)

  await clock.advance(3_000)
  await Promise.all(first)
  expect(notRouted(seen)).toEqual([
    'crew jev: crew:digger not routed (busy)',
    ...Array.from({ length: 4 }, () => 'crew jev: crew:digger not routed (timeout)'),
  ])
})

test('once three calls failed, the fourth is logged as breaker and sends no request', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => rejected(401) })
  for (let i = 0; i < 4; i++) await $.agent.spawn(spawnInput())

  expect(seen.fetches).toHaveLength(3)
  expect(notRouted(seen)).toEqual([
    ...Array.from({ length: 3 }, () => 'crew jev: crew:digger not routed (http 401)'),
    'crew jev: crew:digger not routed (breaker)',
  ])
  expect(seen.spawned.map(s => s.model)).toEqual([undefined, undefined, undefined, undefined])
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['high'])
})

test('the failure line names the agent of the call', ON, async ($, on) => {
  const { seen } = jevWorld(on, { reply: async () => rejected(401) })
  await $.agent.spawn(spawnInput({ subagentType: 'crew:challenger' }))

  expect(notRouted(seen)).toEqual(['crew jev: crew:challenger not routed (http 401)'])
})

// The order inside the spawn: the effort book's entry before the spawn continues, then the record (with the book's
// answer) and its write, the debug lines and the notice, and last the wait for the write.

test('a routed spawn runs in order: request, spawn, decision write, debug line, notice', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), { reply: async () => ok(answer(2.1)) })
  await $.agent.spawn(spawnInput())

  expect(shape(timeline)).toEqual([
    'fetch',
    'spawn',
    'write',
    'log crew jev: crew:digger depth=2.10 model=haiku (default) effort=medium jev=jev-1.13.0 Nms',
    'notice crew:digger -> haiku · medium (jev)',
  ])
  expect(seen.notices).toEqual(['crew:digger -> haiku · medium (jev)'])
  // Nothing stepped, so the bind that the record carries is the plain one.
  expect(record(seen)).toMatchObject({ bind: 'applied', effortPlanned: 'medium', effortApplied: 'medium' })
})

test('the effort entry exists before the spawn continues, and its bind is in the record that is written after', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), {
    reply: async () => ok(answer(2.1)),
    agents: [{ id: 'a1', type: 'crew:digger', description: 'audit auth · haiku/medium' }],
    spawn: async () => {
      // The subagent steps while the spawn is still in flight: only an entry added before it can answer.
      await step($, 'a1', 'high')
      timeline.push(`step ${seen.steps.at(-1)}`)
      return { model: 'default', agentId: 'a1' }
    },
  })
  await $.agent.spawn(spawnInput())

  expect(shape(timeline)).toEqual([
    'fetch',
    'spawn',
    'step medium',
    'write',
    'log crew jev: crew:digger depth=2.10 model=haiku (default) effort=medium jev=jev-1.13.0 Nms',
    'notice crew:digger -> haiku · medium (jev)',
  ])
  expect(record(seen)).toMatchObject({ bind: 'matched', effortPlanned: 'medium', effortApplied: 'medium' })
})

test('an effort that did not take is announced after the decision write, line by line, and the record says what runs', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), {
    reply: async () => ok(answer(2.1)),
    spawn: async () => {
      // Not listed, so the first step runs on the default and the entry cannot take.
      await step($, 'a1', 'high')
      timeline.push(`step ${seen.steps.at(-1)}`)
      return { model: 'default', agentId: 'a1' }
    },
  })
  await $.agent.spawn(spawnInput())

  expect(shape(timeline)).toEqual([
    'fetch',
    'spawn',
    'step high',
    'write',
    'log crew jev: crew:digger depth=2.10 model=haiku (default) effort=unknown jev=jev-1.13.0 Nms',
    'log crew jev: crew:digger effort medium not applied (stepped); its effort is unknown',
    'notice crew:digger -> haiku · effort unknown (jev; effort medium not applied)',
  ])
  expect(record(seen)).toMatchObject({ bind: 'stepped', effortPlanned: 'medium', effortApplied: null })
})

test('the result waits for the decision write for one second after the notice, and not longer', ON, async ($, on) => {
  const timeline: string[] = []
  const { clock } = jevWorld(traced(on, timeline), { writeHang: true })
  let resolved = false
  const spawned = $.agent.spawn(spawnInput()).then(result => { resolved = true; return result })
  await clock.settle()
  await pause()

  // The notice is out and the spawn is still held on the write.
  expect(shape(timeline)).toEqual([
    'fetch',
    'spawn',
    'write',
    'log crew jev: crew:digger depth=2.10 model=haiku (default) effort=medium jev=jev-1.13.0 Nms',
    'notice crew:digger -> haiku · medium (jev)',
  ])
  expect(resolved).toBe(false)
  await clock.advance(999)
  expect(resolved).toBe(false)

  await clock.advance(1)
  expect(await spawned).toMatchObject({ model: 'default', agentId: 'a1' })
  expect(timeline.at(-1)).toBe('log crew jev: decision write slow')
})

test('a call that Jev failed on logs before the spawn and records and announces high', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), { reply: async () => rejected(401) })
  await $.agent.spawn(spawnInput())

  expect(timeline).toEqual(['fetch', 'log crew jev: crew:digger not routed (http 401)', 'spawn', 'write', 'notice crew:digger -> haiku · high'])
  expect(record(seen)).toMatchObject({ effortPlanned: 'high', jevModel: null })
})

test('a refused spawn that was routed logs, announces and writes nothing', ON, async ($, on) => {
  const timeline: string[] = []
  const { seen } = jevWorld(traced(on, timeline), {
    reply: async () => ok(answer(2.1)),
    spawn: async () => ({ deny: 'spawn refused' }) as never,
  })
  await $.agent.spawn(spawnInput())

  expect(timeline).toEqual(['fetch', 'spawn'])
  expect(seen.writes).toEqual([])
})

for (const config of ['invalid-key', 'repository-key', 'settings-failure'] as const) {
  test(`Jev config failure ${config} explicitly pins Claude effort to high`, { options: { jevKey: config === 'invalid-key' ? 'bad key' : KEY } }, async ($, on) => {
    const { seen } = jevWorld(on, {
      ...(config === 'repository-key' ? { project: declared('crew@inline') } : {}),
      settingsFail: config === 'settings-failure',
      stepModel: 'claude-haiku-5-5',
    })
    await $.agent.spawn(spawnInput())
    await step($, 'a1', 'xhigh')
    expect(seen.fetches).toEqual([])
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(seen.steps).toEqual(['high'])
    expect(seen.transcript).toEqual(['crew: audit auth: confirmed claude-haiku-5-5 · high'])
  })
}

test('a failed Jev spawn cannot change effort after the agent has already stepped', ON, async ($, on) => {
  const { seen } = jevWorld(on, {
    reply: async () => rejected(401),
    spawn: async () => {
      await step($, 'a1', 'medium')
      return { model: 'default', agentId: 'a1' }
    },
  })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'xhigh')
  expect(seen.steps).toEqual(['medium', 'xhigh'])
  expect(record(seen)).toMatchObject({ bind: 'stepped', effortPlanned: 'high', effortApplied: null })
  expect(seen.notices).toEqual(['crew:digger -> haiku · effort unknown (crew; effort high not applied)'])
})

for (const [role, model] of [['planner', 'opus'], ['challenger', 'opus'], ['digger', 'haiku']] as const) {
  test(`Jev never supplies a model for Claude role ${role}`, ON, async ($, on) => {
    const { seen } = jevWorld(on)
    await $.agent.spawn(spawnInput({ subagentType: `crew:${role}` }))
    expect(seen.spawned[0]?.subagentType).toBe(`crew:${role}`)
    expect(seen.spawned[0]?.model).toBeUndefined()
    expect(seen.spawned[0]?.description).toBe(`audit auth · ${model}/medium`)
  })
}

for (const reverse of [false, true]) {
  test(`concurrent high answer and fallback do not exchange apply policies (${reverse ? 'reverse' : 'forward'} first steps)`, ON, async ($, on) => {
    let fetched = 0
    let spawned = 0
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const { seen } = jevWorld(on, {
      reply: async () => fetched++ === 0 ? ok(answer(4.6)) : rejected(401),
      agents: [
        { id: 'a1', type: 'crew:digger', description: 'audit auth · haiku/high' },
        { id: 'a2', type: 'crew:digger', description: 'audit auth · haiku/high' },
      ],
      spawn: async () => { const agentId = `a${++spawned}`; await held; return { model: 'default', agentId } },
    })
    const first = $.agent.spawn(spawnInput())
    while (seen.spawned.length < 1) await pause()
    const second = $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
    while (seen.spawned.length < 2) await pause()
    const order = reverse ? ['a2', 'a1'] : ['a1', 'a2']
    for (const id of order) await step($, id, 'xhigh')
    release()
    await Promise.all([first, second])
    for (const id of order) await step($, id, 'xhigh')
    // The host gives no safe identity between pending calls with identical tags and different apply policies.
    // Both remain unchanged, rather than assigning one call's fallback to the other; no late bind may repair it.
    expect(seen.steps).toEqual(['xhigh', 'xhigh', 'xhigh', 'xhigh'])
    expect(record(seen, 1)).toMatchObject({ bind: 'stepped', effortPlanned: 'high', effortApplied: null })
    expect(seen.notices[1]).toBe('crew:digger -> haiku · effort unknown (crew; effort high not applied)')
  })
}

test('a resumed medium agent reports its fixed effort when the high fallback cannot apply', ON, async ($, on) => {
  let failing = false
  const { seen } = jevWorld(on, {
    reply: async () => failing ? rejected(401) : ok(answer(2.1)),
    stepModel: 'claude-sonnet-5-5',
  })
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')
  failing = true
  await $.agent.spawn(spawnInput({ tool_use_id: 'tu2' }))
  await step($, 'a1', 'high')
  expect(seen.steps).toEqual(['medium', 'medium'])
  expect(seen.notices[1]).toBe('crew:digger -> haiku · medium (crew; effort high not applied)')
  expect(record(seen, 2)).toMatchObject({ bind: 'known', effortPlanned: 'high', effortApplied: 'medium', applied: { effort: true }, ran: null })
  expect(record(seen, 3)).toMatchObject({ effortPlanned: 'high', effortApplied: 'medium', ran: { effort: 'medium' } })
})
