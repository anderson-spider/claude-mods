import { describe, expect, test } from 'claude-code/testing'
import { loadConfig } from '../hooks/config'
import { DEFAULT_CONFIG } from '../hooks/defaults'
import type { ConfigResult, ReadFile } from '../hooks/types'

const readFiles = (files: Record<string, string>): ReadFile => async path => files[path]
const load = (user: unknown, project?: unknown) => loadConfig(readFiles({
  u: JSON.stringify(user),
  ...(project === undefined ? {} : { p: JSON.stringify(project) }),
}), { user: 'u', project: 'p' })

function valid(result: ConfigResult) {
  if (!result.ok) throw new Error(result.error)
  return result
}

describe('loadConfig', () => {
  test('defaults when no files', async () => {
    const result = valid(await loadConfig(async () => undefined, { user: 'u' }))
    expect(result.config).toEqual(DEFAULT_CONFIG)
    expect(result.config.sandboxCap).toBe('workspace-write')
    expect(result.config.agents.fixer.model).toBe('gpt-6-luna')
  })

  test('reads only the injected paths, including an optional project file', async () => {
    const read: ReadFile = async path => {
      if (path === '/user/settings') return '{"foregroundMinutes":2}'
      if (path === '/repo/settings') return '{"foregroundMinutes":3}'
      throw new Error('unexpected path')
    }
    expect(valid(await loadConfig(read, { user: '/user/settings' })).config.foregroundMinutes).toBe(2)
    expect(valid(await loadConfig(read, {
      user: '/user/settings', project: '/repo/settings',
    })).config.foregroundMinutes).toBe(3)
  })

  test('project config works without a user file', async () => {
    const result = valid(await loadConfig(readFiles({ p: '{"foregroundMinutes":1.5}' }), {
      user: 'u', project: 'p',
    }))
    expect(result.config.foregroundMinutes).toBe(1.5)
  })

  test('project cannot loosen user cap', async () => {
    const result = valid(await load(
      { sandboxCap: 'read-only', noNetwork: true },
      { sandboxCap: 'workspace-write', noNetwork: false },
    ))
    expect(result.config.sandboxCap).toBe('read-only')
    expect(result.config.noNetwork).toBe(true)
    expect(result.origins.sandboxCap).toBe('user')
    expect(result.origins.noNetwork).toBe('user')
  })

  test('project can tighten user policy', async () => {
    const result = valid(await load(
      { sandboxCap: 'workspace-write', noNetwork: false },
      { sandboxCap: 'read-only', noNetwork: true },
    ))
    expect(result.config.sandboxCap).toBe('read-only')
    expect(result.config.noNetwork).toBe(true)
    expect(result.origins.sandboxCap).toBe('project')
    expect(result.origins.noNetwork).toBe('project')
  })

  test('project overrides functional fields; disabledAgents is a union', async () => {
    const result = valid(await load({
      foregroundMinutes: 2,
      disabledAgents: ['oracle', 'oracle'],
      agents: { fixer: { model: 'user-model', effort: 'high', prompt: 'user prompt' } },
      council: { seats: { alpha: { engine: 'codex', model: 'user-seat', prompt: 'seat prompt' } } },
    }, {
      foregroundMinutes: 3,
      disabledAgents: ['council', 'oracle'],
      agents: { fixer: { model: 'project-model', sandbox: 'read-only' } },
      council: { seats: { alpha: { engine: 'claude', effort: 'low' }, gamma: { engine: 'codex' } } },
    }))
    expect(result.config.foregroundMinutes).toBe(3)
    expect(result.config.disabledAgents).toEqual(['oracle', 'council'])
    expect(result.config.agents.fixer).toEqual({
      model: 'project-model', sandbox: 'read-only', effort: 'high', prompt: 'user prompt',
    })
    expect(result.config.agents.explorer).toEqual({ model: 'gpt-6-luna', sandbox: 'read-only' })
    expect(result.config.council.seats).toEqual({
      alpha: { engine: 'claude', model: 'user-seat', effort: 'low', prompt: 'seat prompt' },
      beta: { engine: 'claude', model: 'opus' },
      gamma: { engine: 'codex' },
    })
  })

  test('accepts custom prompts for native roles and disabled councillors', async () => {
    const result = valid(await load({
      disabledAgents: ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'council', 'councillor:alpha'],
      agents: { oracle: { model: 'sonnet', effort: 'high', prompt: '' }, designer: { prompt: 'custom' } },
    }))
    expect(result.config.agents.oracle).toEqual({ model: 'sonnet', effort: 'high', prompt: '' })
    expect(result.config.agents.designer).toEqual({ model: 'inherit', prompt: 'custom' })
    expect(result.config.disabledAgents).toContain('councillor:alpha')
  })

  test('origins report where each field came from', async () => {
    const result = valid(await load({
      agents: { fixer: { model: 'user-model', effort: 'high' } },
      council: { seats: { alpha: { engine: 'codex', prompt: 'extra' } } },
    }, {
      foregroundMinutes: 8,
      disabledAgents: ['council'],
      agents: { fixer: { model: 'project-model' } },
    }))
    expect(result.origins.foregroundMinutes).toBe('project')
    expect(result.origins.disabledAgents).toBe('project')
    expect(result.origins['agents.fixer.model']).toBe('project')
    expect(result.origins['agents.fixer.effort']).toBe('user')
    expect(result.origins['agents.fixer.sandbox']).toBe('default')
    expect(result.origins['agents.oracle.model']).toBe('default')
    expect(result.origins['council.seats.alpha.prompt']).toBe('user')
    expect(result.origins['council.seats.alpha.engine']).toBe('user')
    expect(result.origins['council.seats.alpha.effort']).toBe('default')
    expect(result.origins['council.seats.beta.model']).toBe('default')
    expect(result.origins.noNetwork).toBe('default')
  })

  for (const [name, json, field] of [
    ['top level array', '[]', 'config'],
    ['top level null', 'null', 'config'],
    ['top level string', '"config"', 'config'],
    ['unknown field', '{"unknown":true}', 'unknown'],
    ['unknown role', '{"agents":{"stranger":{}}}', 'agents.stranger'],
    ['unknown nested field', '{"agents":{"fixer":{"modle":"x"}}}', 'agents.fixer.modle'],
    ['top level prototype key', '{"__proto__":{}}', '__proto__'],
    ['unknown council field', '{"council":{"enabled":true}}', 'council.enabled'],
    ['unknown seat field', '{"council":{"seats":{"alpha":{"engine":"codex","sandbox":"read-only"}}}}', 'council.seats.alpha.sandbox'],
    ['invalid cap', '{"sandboxCap":"other"}', 'sandboxCap'],
    ['non boolean network', '{"noNetwork":"false"}', 'noNetwork'],
    ['non numeric timeout', '{"foregroundMinutes":"5"}', 'foregroundMinutes'],
    ['zero timeout', '{"foregroundMinutes":0}', 'foregroundMinutes'],
    ['negative timeout', '{"foregroundMinutes":-1}', 'foregroundMinutes'],
    ['infinite timeout', '{"foregroundMinutes":1e999}', 'foregroundMinutes'],
    ['non array disabled agents', '{"disabledAgents":"oracle"}', 'disabledAgents'],
    ['non string disabled agent', '{"disabledAgents":[1]}', 'disabledAgents'],
    ['unknown disabled agent', '{"disabledAgents":["stranger"]}', 'disabledAgents'],
    ['empty councillor name', '{"disabledAgents":["councillor:"]}', 'disabledAgents'],
    ['non object agents', '{"agents":[]}', 'agents'],
    ['null role', '{"agents":{"oracle":null}}', 'agents.oracle'],
    ['non string model', '{"agents":{"fixer":{"model":2}}}', 'agents.fixer.model'],
    ['non string effort', '{"agents":{"oracle":{"effort":true}}}', 'agents.oracle.effort'],
    ['non string prompt', '{"agents":{"designer":{"prompt":[]}}}', 'agents.designer.prompt'],
    ['invalid role sandbox', '{"agents":{"fixer":{"sandbox":"other"}}}', 'agents.fixer.sandbox'],
    ['native sandbox', '{"agents":{"oracle":{"sandbox":"read-only"}}}', 'agents.oracle.sandbox'],
    ['non object council', '{"council":false}', 'council'],
    ['non object seats', '{"council":{"seats":[]}}', 'council.seats'],
    ['null seat', '{"council":{"seats":{"gamma":null}}}', 'council.seats.gamma'],
    ['missing engine on a new seat', '{"council":{"seats":{"gamma":{"model":"x"}}}}', 'council.seats.gamma.engine'],
    ['invalid seat engine', '{"council":{"seats":{"alpha":{"engine":"other"}}}}', 'council.seats.alpha.engine'],
    ['non string seat model', '{"council":{"seats":{"alpha":{"engine":"codex","model":2}}}}', 'council.seats.alpha.model'],
    ['non string seat effort', '{"council":{"seats":{"alpha":{"engine":"codex","effort":null}}}}', 'council.seats.alpha.effort'],
    ['non string seat prompt', '{"council":{"seats":{"alpha":{"engine":"claude","prompt":false}}}}', 'council.seats.alpha.prompt'],
  ] as const) {
    test(`rejects ${name} with its field path`, async () => {
      const result = await loadConfig(readFiles({ u: json }), { user: 'u' })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('invalid config accepted')
      expect(result.error).toContain(field)
      expect(result.error).toContain('u')
      expect(result.config).toBe(DEFAULT_CONFIG)
    })
  }

  for (const json of [
    '{"sandboxCap":"danger-full-access"}',
    '{"agents":{"fixer":{"sandbox":"danger-full-access"}}}',
    '{"agents":{"designer":{"sandbox":"danger-full-access"}}}',
  ]) {
    test(`danger-full-access is rejected: ${json}`, async () => {
      const result = await loadConfig(readFiles({ u: json }), { user: 'u' })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unsafe config accepted')
      expect(result.error).toContain('danger-full-access')
    })
  }

  test('invalid JSON keeps lastValid', async () => {
    const lastValid = valid(await load({ sandboxCap: 'read-only', noNetwork: true })).config
    const result = await loadConfig(readFiles({ u: '{ broken' }), { user: 'u' }, lastValid)
    expect(result.ok).toBe(false)
    expect(result.config).toBe(lastValid)
    if (result.ok) throw new Error('invalid JSON accepted')
    expect(result.error).toContain('u')
    expect(result.error).toContain('JSON')
  })

  test('invalid project keeps lastValid rather than a partially merged config', async () => {
    const lastValid = valid(await load({ sandboxCap: 'read-only', noNetwork: true })).config
    const result = await loadConfig(readFiles({ u: '{"foregroundMinutes":9}', p: '{"unknown":true}' }), {
      user: 'u', project: 'p',
    }, lastValid)
    expect(result.ok).toBe(false)
    expect(result.config).toBe(lastValid)
    if (result.ok) throw new Error('invalid project accepted')
    expect(result.error).toContain('p')
  })

  test('read errors keep lastValid and report the failing path', async () => {
    const lastValid = valid(await load({ sandboxCap: 'read-only' })).config
    const result = await loadConfig(async () => { throw new Error('unreadable') }, { user: 'u' }, lastValid)
    expect(result.ok).toBe(false)
    expect(result.config).toBe(lastValid)
    if (result.ok) throw new Error('read error ignored')
    expect(result.error).toContain('u')
    expect(result.error).toContain('unreadable')
  })

  test('rereads config so a corrected file clears the error', async () => {
    let text = '{ broken'
    const read: ReadFile = async () => text
    const first = await loadConfig(read, { user: 'u' })
    expect(first.ok).toBe(false)
    text = '{"foregroundMinutes":2}'
    const second = valid(await loadConfig(read, { user: 'u' }, first.config))
    expect(second.config.foregroundMinutes).toBe(2)
  })

  test('successful loads are independent of defaults, previous results and lastValid', async () => {
    const first = valid(await load({ agents: { fixer: { effort: 'high' } } }))
    first.config.disabledAgents.push('oracle')
    first.config.agents.fixer.model = 'mutated'
    first.config.council.seats.alpha!.model = 'mutated'
    const second = valid(await loadConfig(async () => undefined, { user: 'u' }, first.config))
    expect(second.config.disabledAgents).toEqual([])
    expect(second.config.agents.fixer).toEqual({ model: 'gpt-6-luna', sandbox: 'workspace-write' })
    expect(second.config.council.seats.alpha?.model).toBe('gpt-6-astra')
    expect(DEFAULT_CONFIG.agents.fixer.model).toBe('gpt-6-luna')
    expect(DEFAULT_CONFIG.council.seats.alpha?.model).toBe('gpt-6-astra')
    expect(DEFAULT_CONFIG.disabledAgents).toEqual([])
  })
})

test('partial override of an existing seat keeps its engine', async () => {
  const result = await loadConfig(readFiles({ u: '{"council":{"seats":{"alpha":{"effort":"low"}}}}' }), { user: 'u' })
  expect(result.ok).toBe(true)
  expect(result.config.council.seats.alpha).toEqual({ engine: 'codex', model: 'gpt-6-astra', effort: 'low' })
})
