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

function rejected(result: ConfigResult) {
  if (result.ok) throw new Error('invalid config accepted')
  return result.error
}

describe('defaults', () => {
  test('without any file the config equals DEFAULT_CONFIG', async () => {
    const result = valid(await loadConfig(async () => undefined, { user: 'u' }))
    expect(result.config).toEqual(DEFAULT_CONFIG)
    expect(result.config.agents).toEqual({
      explorer: { model: 'haiku' },
      librarian: { model: 'haiku' },
      executor: { model: 'sonnet' },
      oracle: { model: 'opus' },
      designer: { model: 'sonnet' },
      git: { model: 'haiku' },
    })
    expect(result.config.council.seats).toEqual({ alpha: { model: 'opus' }, beta: { model: 'sonnet' } })
    expect(result.config.disabledAgents).toEqual([])
  })

  test('DEFAULT_CONFIG is deeply frozen', () => {
    const walk = (value: object): void => {
      expect(Object.isFrozen(value)).toBe(true)
      for (const child of Object.values(value)) if (typeof child === 'object' && child !== null) walk(child)
    }
    walk(DEFAULT_CONFIG)
  })
})

describe('loadConfig', () => {
  test('reads only the injected paths, including an optional project file', async () => {
    const read: ReadFile = async path => {
      if (path === '/user/settings') return '{"agents":{"oracle":{"effort":"low"}}}'
      if (path === '/repo/settings') return '{"agents":{"oracle":{"effort":"high"}}}'
      throw new Error('unexpected path')
    }
    expect(valid(await loadConfig(read, { user: '/user/settings' })).config.agents.oracle.effort).toBe('low')
    expect(valid(await loadConfig(read, {
      user: '/user/settings', project: '/repo/settings',
    })).config.agents.oracle.effort).toBe('high')
  })

  test('project config works without a user file', async () => {
    const result = valid(await loadConfig(readFiles({ p: '{"agents":{"git":{"effort":"low"}}}' }), {
      user: 'u', project: 'p',
    }))
    expect(result.config.agents.git).toEqual({ model: 'haiku', effort: 'low' })
  })

  test('user then project merge field by field', async () => {
    const result = valid(await load({
      agents: { executor: { model: 'opus', effort: 'high', prompt: 'user prompt' } },
      council: { seats: { alpha: { prompt: 'seat prompt', effort: 'high' } } },
    }, {
      agents: { executor: { model: 'claude-sonnet-4-5' } },
      council: { seats: { alpha: { effort: 'low' } } },
    }))
    expect(result.config.agents.executor).toEqual({ model: 'claude-sonnet-4-5', effort: 'high', prompt: 'user prompt' })
    expect(result.config.agents.explorer).toEqual({ model: 'haiku' })
    expect(result.config.council.seats).toEqual({
      alpha: { model: 'opus', effort: 'low', prompt: 'seat prompt' },
      beta: { model: 'sonnet' },
    })
  })

  test('disabledAgents is a union without duplicates', async () => {
    const result = valid(await load(
      { disabledAgents: ['oracle', 'oracle'] },
      { disabledAgents: ['council', 'oracle', 'councillor:alpha'] },
    ))
    expect(result.config.disabledAgents).toEqual(['oracle', 'council', 'councillor:alpha'])
  })

  test('accepts every role and councillor in disabledAgents with custom prompts', async () => {
    const result = valid(await load({
      disabledAgents: ['explorer', 'librarian', 'executor', 'oracle', 'designer', 'git', 'council', 'councillor:alpha'],
      agents: { oracle: { prompt: '' }, designer: { prompt: 'custom' } },
    }))
    expect(result.config.agents.oracle).toEqual({ model: 'opus', prompt: '' })
    expect(result.config.agents.designer).toEqual({ model: 'sonnet', prompt: 'custom' })
    expect(result.config.disabledAgents).toContain('councillor:alpha')
  })

  test('accepts agents.executor and disabledAgents executor', async () => {
    const result = valid(await load({
      agents: { executor: { prompt: 'Execute the assigned brief' } },
      disabledAgents: ['executor'],
    }))
    expect(result.config.agents.executor).toEqual({ model: 'sonnet', prompt: 'Execute the assigned brief' })
    expect(result.config.disabledAgents).toEqual(['executor'])
  })

  test('a new seat is accepted with or without a model', async () => {
    const withModel = valid(await load({ council: { seats: { gamma: { model: 'haiku' } } } }))
    expect(withModel.config.council.seats.gamma).toEqual({ model: 'haiku' })
    const without = valid(await load({ council: { seats: { gamma: { prompt: 'think' } } } }))
    expect(without.config.council.seats.gamma).toEqual({ prompt: 'think' })
    const empty = valid(await load({ council: { seats: { gamma: {} } } }))
    expect(empty.config.council.seats.gamma).toEqual({})
    expect(Object.keys(empty.config.council.seats)).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('a seat declared by the user can be completed by the project', async () => {
    const result = valid(await load(
      { council: { seats: { gamma: { prompt: 'think' } } } },
      { council: { seats: { gamma: { model: 'opus' } } } },
    ))
    expect(result.config.council.seats.gamma).toEqual({ prompt: 'think', model: 'opus' })
  })

  test('partial override of an existing seat keeps its model', async () => {
    const result = valid(await load({ council: { seats: { alpha: { effort: 'low' } } } }))
    expect(result.config.council.seats.alpha).toEqual({ model: 'opus', effort: 'low' })
  })

  test('Claude model ids and aliases with a context suffix are accepted', async () => {
    const result = valid(await load({
      agents: { oracle: { model: 'opus[1m]' }, explorer: { model: 'claude-haiku-4-5' }, git: { model: 'inherit' } },
      council: { seats: { alpha: { model: 'claude-opus-4-1' } } },
    }))
    expect(result.config.agents.oracle.model).toBe('opus[1m]')
    expect(result.config.agents.git.model).toBe('inherit')
    expect(result.config.council.seats.alpha?.model).toBe('claude-opus-4-1')
  })

  test('origins report where each field came from', async () => {
    const result = valid(await load({
      agents: { executor: { model: 'opus', effort: 'high' } },
      council: { seats: { alpha: { prompt: 'extra' }, gamma: { model: 'haiku' } } },
    }, {
      disabledAgents: ['council'],
      agents: { executor: { model: 'haiku' } },
    }))
    expect(result.origins.disabledAgents).toBe('project')
    expect(result.origins['agents.executor.model']).toBe('project')
    expect(result.origins['agents.executor.effort']).toBe('user')
    expect(result.origins['agents.oracle.model']).toBe('default')
    expect(result.origins['council.seats.alpha.prompt']).toBe('user')
    expect(result.origins['council.seats.alpha.model']).toBe('default')
    expect(result.origins['council.seats.gamma']).toBe('user')
    expect(result.origins['council.seats.gamma.model']).toBe('user')
    expect(result.origins['council.seats.beta.model']).toBe('default')
  })

  test('disabledAgents has no origin until a file sets it', async () => {
    expect(valid(await load({})).origins.disabledAgents).toBeUndefined()
    expect(valid(await load({ disabledAgents: ['git'] })).origins.disabledAgents).toBe('user')
  })

  for (const [name, config, message] of [
    ['agents.fixer', { agents: { fixer: {} } }, 'agents.fixer: role `fixer` was renamed to `executor`; use `agents.executor`'],
    ['disabled fixer', { disabledAgents: ['fixer'] }, 'disabledAgents: role `fixer` was renamed to `executor`; use `executor` in `disabledAgents`'],
  ] as const) {
    test(`rejects ${name} with executor migration guidance in either file`, async () => {
      expect(rejected(await load(config))).toBe(`u: ${message}`)
      expect(rejected(await load({}, config))).toBe(`p: ${message}`)
    })
  }

  for (const [field, json] of [
    ['profile', '{"profile":"claude"}'],
    ['profiles', '{"profiles":{"mine":{}}}'],
    ['sandboxCap', '{"sandboxCap":"read-only"}'],
    ['noNetwork', '{"noNetwork":true}'],
    ['foregroundMinutes', '{"foregroundMinutes":5}'],
  ] as const) {
    test(`removed field ${field} fails with a migration message`, async () => {
      const result = await loadConfig(readFiles({ u: json }), { user: 'u' })
      const error = rejected(result)
      expect(error).toContain(`u: ${field}: `)
      expect(error).toContain('Pantheon runs only native Claude agents')
      expect(result.config).toBe(DEFAULT_CONFIG)
    })
  }

  test('removed profile fields tell where the settings went', async () => {
    const profile = rejected(await load({ profile: 'mixed' }))
    expect(profile).toContain('agents.<role>')
    expect(profile).toContain('council.seats.<seat>')
    const profiles = rejected(await load({ profiles: {} }))
    expect(profiles).toContain('profiles.<name>.agents.<role>')
  })

  for (const [field, json] of [
    ['agents.executor.engine', '{"agents":{"executor":{"engine":"codex"}}}'],
    ['agents.executor.sandbox', '{"agents":{"executor":{"sandbox":"read-only"}}}'],
    ['council.seats.alpha.engine', '{"council":{"seats":{"alpha":{"engine":"claude"}}}}'],
    ['council.seats.alpha.sandbox', '{"council":{"seats":{"alpha":{"sandbox":"read-only"}}}}'],
  ] as const) {
    test(`removed entry field ${field} fails with a migration message`, async () => {
      const error = rejected(await loadConfig(readFiles({ u: json }), { user: 'u' }))
      expect(error).toContain(`u: ${field}: `)
      expect(error).toContain('delete it')
    })
  }

  for (const [name, json, field] of [
    ['an agent role', '{"agents":{"oracle":{"model":"gpt-6-astra"}}}', 'agents.oracle.model'],
    ['another agent role', '{"agents":{"git":{"model":"gemini-3"}}}', 'agents.git.model'],
    ['a seat', '{"council":{"seats":{"alpha":{"model":"gpt-6-luna"}}}}', 'council.seats.alpha.model'],
    ['a new seat', '{"council":{"seats":{"gamma":{"model":"o4"}}}}', 'council.seats.gamma.model'],
  ] as const) {
    test(`rejects a non-Claude model for ${name}`, async () => {
      const error = rejected(await loadConfig(readFiles({ u: json }), { user: 'u' }))
      expect(error).toContain(`u: ${field}: `)
      expect(error).toContain('is not a Claude model')
    })
  }

  for (const [name, json, field] of [
    ['top level array', '[]', 'config'],
    ['top level null', 'null', 'config'],
    ['top level string', '"config"', 'config'],
    ['unknown field', '{"unknown":true}', 'unknown'],
    ['unknown role', '{"agents":{"stranger":{}}}', 'agents.stranger'],
    ['unknown nested field', '{"agents":{"executor":{"modle":"x"}}}', 'agents.executor.modle'],
    ['top level prototype key', '{"__proto__":{}}', '__proto__'],
    ['unknown council field', '{"council":{"enabled":true}}', 'council.enabled'],
    ['unknown seat field', '{"council":{"seats":{"alpha":{"color":"red"}}}}', 'council.seats.alpha.color'],
    ['non array disabled agents', '{"disabledAgents":"oracle"}', 'disabledAgents'],
    ['non string disabled agent', '{"disabledAgents":[1]}', 'disabledAgents'],
    ['unknown disabled agent', '{"disabledAgents":["stranger"]}', 'disabledAgents'],
    ['empty councillor name', '{"disabledAgents":["councillor:"]}', 'disabledAgents'],
    ['non object agents', '{"agents":[]}', 'agents'],
    ['null role', '{"agents":{"oracle":null}}', 'agents.oracle'],
    ['non string model', '{"agents":{"executor":{"model":2}}}', 'agents.executor.model'],
    ['non string effort', '{"agents":{"oracle":{"effort":true}}}', 'agents.oracle.effort'],
    ['non string prompt', '{"agents":{"designer":{"prompt":[]}}}', 'agents.designer.prompt'],
    ['non object council', '{"council":false}', 'council'],
    ['non object seats', '{"council":{"seats":[]}}', 'council.seats'],
    ['null seat', '{"council":{"seats":{"gamma":null}}}', 'council.seats.gamma'],
    ['non string seat model', '{"council":{"seats":{"alpha":{"model":2}}}}', 'council.seats.alpha.model'],
    ['non string seat effort', '{"council":{"seats":{"alpha":{"effort":null}}}}', 'council.seats.alpha.effort'],
    ['non string seat prompt', '{"council":{"seats":{"alpha":{"prompt":false}}}}', 'council.seats.alpha.prompt'],
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

  test('non-string fields say "expected string"', async () => {
    expect(rejected(await load({ agents: { executor: { model: 2 } } }))).toBe('u: agents.executor.model: expected string')
    expect(rejected(await load({ council: { seats: { alpha: { prompt: false } } } }))).toBe('u: council.seats.alpha.prompt: expected string')
  })

  test('invalid JSON keeps lastValid', async () => {
    const lastValid = valid(await load({ agents: { oracle: { effort: 'low' } } })).config
    const result = await loadConfig(readFiles({ u: '{ broken' }), { user: 'u' }, lastValid)
    expect(result.ok).toBe(false)
    expect(result.config).toBe(lastValid)
    if (result.ok) throw new Error('invalid JSON accepted')
    expect(result.error).toContain('u')
    expect(result.error).toContain('JSON')
  })

  test('error fallback without lastValid is DEFAULT_CONFIG', async () => {
    const result = await loadConfig(readFiles({ u: 'not json' }), { user: 'u' })
    expect(result.ok).toBe(false)
    expect(result.config).toBe(DEFAULT_CONFIG)
  })

  test('invalid project keeps lastValid rather than a partially merged config', async () => {
    const lastValid = valid(await load({ agents: { oracle: { effort: 'low' } } })).config
    const result = await loadConfig(readFiles({ u: '{"agents":{"git":{"effort":"high"}}}', p: '{"unknown":true}' }), {
      user: 'u', project: 'p',
    }, lastValid)
    expect(result.ok).toBe(false)
    expect(result.config).toBe(lastValid)
    if (result.ok) throw new Error('invalid project accepted')
    expect(result.error).toContain('p')
  })

  test('read errors keep lastValid and report the failing path', async () => {
    const lastValid = valid(await load({ agents: { oracle: { effort: 'low' } } })).config
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
    text = '{"agents":{"oracle":{"effort":"low"}}}'
    const second = valid(await loadConfig(read, { user: 'u' }, first.config))
    expect(second.config.agents.oracle.effort).toBe('low')
  })

  test('successful loads are independent of defaults, previous results and lastValid', async () => {
    const first = valid(await load({ agents: { executor: { effort: 'high' } } }))
    first.config.disabledAgents.push('oracle')
    first.config.agents.executor.model = 'mutated'
    first.config.council.seats.alpha!.model = 'mutated'
    const second = valid(await loadConfig(async () => undefined, { user: 'u' }, first.config))
    expect(second.config.disabledAgents).toEqual([])
    expect(second.config.agents.executor).toEqual({ model: 'sonnet' })
    expect(second.config.council.seats.alpha?.model).toBe('opus')
    expect(DEFAULT_CONFIG.agents.executor.model).toBe('sonnet')
    expect(DEFAULT_CONFIG.council.seats.alpha?.model).toBe('opus')
    expect(DEFAULT_CONFIG.disabledAgents).toEqual([])
  })
})
