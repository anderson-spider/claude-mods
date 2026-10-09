import { describe, expect, test } from 'claude-code/testing'
import { loadConfig } from '../hooks/config'
import { DEFAULT_CONFIG } from '../hooks/defaults'
import type { ConfigResult, ReadFile } from '../hooks/types'

const readFiles = (files: Record<string, string>): ReadFile => async path => files[path]
const load = (user: unknown, project?: unknown, selected?: string) => loadConfig(readFiles({
  u: JSON.stringify(user),
  ...(project === undefined ? {} : { p: JSON.stringify(project) }),
}), { user: 'u', project: 'p' }, undefined, selected)

function valid(result: ConfigResult) {
  if (!result.ok) throw new Error(result.error)
  return result
}

function rejected(result: ConfigResult) {
  if (result.ok) throw new Error('invalid config accepted')
  return result.error
}

describe('profiles', () => {
  test('settings alone select the profile and its origin', async () => {
    const result = valid(await loadConfig(async () => undefined, { user: 'u' }, undefined, 'codex'))
    expect(result.config.profile).toBe('codex')
    expect(result.config.agents.fixer.engine).toBe('codex')
    expect(result.origins.profile).toBe('settings')
    expect(result.origins['agents.fixer.engine']).toBe('default')
    expect(valid(await load({}, undefined, 'claude')).origins.profile).toBe('settings')
  })

  test('user JSON overrides the settings profile', async () => {
    const result = valid(await load({ profile: 'mixed' }, undefined, 'codex'))
    expect(result.config.profile).toBe('mixed')
    expect(result.origins.profile).toBe('user')
  })

  test('project JSON overrides the user and settings profiles', async () => {
    const result = valid(await load({ profile: 'mixed' }, { profile: 'claude' }, 'codex'))
    expect(result.config.profile).toBe('claude')
    expect(result.origins.profile).toBe('project')
  })

  test('unknown settings profile reports the known names without a file prefix', async () => {
    const result = await load({}, { profiles: { mine: {} } }, 'nope')
    expect(rejected(result)).toBe('profile: unknown profile "nope"; known: claude, codex, mixed, mine')
    expect(result.profiles).toEqual(['claude', 'codex', 'mixed', 'mine'])
    expect(result.config).toBe(DEFAULT_CONFIG)
  })

  test('JSON may override an unknown settings profile', async () => {
    expect(valid(await load({ profile: 'codex' }, undefined, 'nope')).config.profile).toBe('codex')
    expect(valid(await load({}, { profile: 'mixed' }, 'nope')).config.profile).toBe('mixed')
  })

  test('profiles list built-in and merged custom names once', async () => {
    expect(valid(await load({})).profiles).toEqual(['claude', 'codex', 'mixed'])
    const result = valid(await load({ profiles: { mine: {}, codex: {} } }, {
      profiles: { mine: {}, team: {} },
    }, 'team'))
    expect(result.profiles).toEqual(['claude', 'codex', 'mixed', 'mine', 'team'])
    expect(result.config.profile).toBe('team')
    expect(result.origins.profile).toBe('settings')
  })

  test('errors expose the profile names known before failure', async () => {
    const unreadable = await loadConfig(readFiles({ u: 'not json' }), { user: 'u' })
    expect(unreadable.ok).toBe(false)
    expect(unreadable.profiles).toEqual(['claude', 'codex', 'mixed'])
    const projectError = await loadConfig(readFiles({ u: '{"profiles":{"mine":{}}}', p: 'not json' }), {
      user: 'u', project: 'p',
    })
    expect(projectError.ok).toBe(false)
    expect(projectError.profiles).toEqual(['claude', 'codex', 'mixed', 'mine'])
    const mergedError = await load({ profiles: { mine: { agents: { fixer: { model: 'gpt-6-astra' } } } } }, {
      profiles: { team: {} },
    })
    expect(mergedError.ok).toBe(false)
    expect(mergedError.profiles).toEqual(['claude', 'codex', 'mixed', 'mine', 'team'])
  })

  test('built-in codex and mixed', async () => {
    const codex = valid(await load({ profile: 'codex' })).config
    expect(codex.agents.oracle).toEqual({ engine: 'codex', model: 'gpt-6-astra', effort: 'high', sandbox: 'read-only' })
    expect(codex.agents.designer).toEqual({ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', sandbox: 'workspace-write' })
    expect(codex.council.seats.beta).toEqual({ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' })
    const mixed = valid(await load({ profile: 'mixed' })).config
    expect(mixed.agents.explorer).toEqual({ engine: 'codex', model: 'gpt-6-luna', effort: 'high', sandbox: 'read-only' })
    expect(mixed.agents.fixer.model).toBe('gpt-6.1-sol')
    expect(mixed.agents.oracle).toEqual({ engine: 'claude', model: 'opus', sandbox: 'read-only' })
    expect(mixed.council.seats).toEqual({
      alpha: { engine: 'codex', model: 'gpt-6-astra', effort: 'high' }, beta: { engine: 'claude', model: 'opus' },
    })
  })

  test('error fallback without lastValid is DEFAULT_CONFIG', async () => {
    const result = await loadConfig(readFiles({ u: 'not json' }), { user: 'u' })
    expect(result.ok).toBe(false)
    expect(result.config).toEqual(DEFAULT_CONFIG)
  })

  test('project profile overrides user', async () => {
    expect(valid(await load({ profile: 'codex' }, { profile: 'mixed' })).config.profile).toBe('mixed')
  })

  test('profile defined in project, named in user', async () => {
    const result = valid(await load({ profile: 'mine' }, {
      profiles: { mine: { agents: { oracle: { engine: 'codex', model: 'gpt-6-astra' } } } },
    }))
    expect(result.config.agents.oracle).toEqual({ engine: 'codex', model: 'gpt-6-astra', sandbox: 'read-only' })
    expect(result.config.agents.explorer.model).toBe('haiku')
  })

  test('profile edits merge over built-ins', async () => {
    const result = valid(await load({ profile: 'mixed', profiles: { mixed: { agents: { fixer: { model: 'gpt-6-astra' } } } } }))
    expect(result.config.agents.fixer).toEqual({ engine: 'codex', model: 'gpt-6-astra', effort: 'high', sandbox: 'workspace-write' })
  })

  test('new profile inherits the merged claude and its origins', async () => {
    const result = valid(await load({ profiles: { claude: { agents: { explorer: { model: 'sonnet' } } }, mine: {} }, profile: 'mine' }))
    expect(result.config.agents.explorer.model).toBe('sonnet')
    expect(result.origins['agents.explorer.model']).toBe('user')
    expect(result.origins['agents.fixer.model']).toBe('default')
  })

  test('custom inheritance uses the final claude and preserves layer engine switches', async () => {
    const result = valid(await load({ profile: 'mine', profiles: { mine: {
      agents: { explorer: { engine: 'codex', model: 'gpt-6-luna', effort: 'high' } },
    } } }, { profiles: {
      claude: { agents: { fixer: { model: 'opus' } } },
      mine: { agents: { explorer: { engine: 'claude' } } },
    } }))
    expect(result.config.agents.explorer).toEqual({ engine: 'claude', sandbox: 'read-only' })
    expect(result.config.agents.fixer.model).toBe('opus')
    expect(result.origins['agents.explorer.model']).toBeUndefined()
    expect(result.origins['agents.explorer.effort']).toBeUndefined()
    expect(result.origins['agents.explorer.engine']).toBe('project')
    expect(result.origins['agents.fixer.model']).toBe('project')
  })

  test('engine switch drops inherited model and effort', async () => {
    const mine = valid(await load({ profile: 'mine', profiles: { mine: {
      agents: { oracle: { engine: 'codex', model: 'gpt-6-astra' } },
      council: { seats: { beta: { engine: 'codex' } } },
    } } })).config
    expect(mine.council.seats.beta).toEqual({ engine: 'codex' })
    expect(mine.agents.oracle.model).toBe('gpt-6-astra')
    const mixed = valid(await load({ profile: 'mixed', profiles: { mixed: { agents: { oracle: { engine: 'codex' } } } } }))
    expect(mixed.config.agents.oracle).toEqual({ engine: 'codex', sandbox: 'read-only' })
    expect(mixed.origins['agents.oracle.model']).toBeUndefined()
    const codex = valid(await load({ profile: 'codex', profiles: { codex: { agents: { explorer: { engine: 'claude' } } } } }))
    expect(codex.config.agents.explorer).toEqual({ engine: 'claude', sandbox: 'read-only' })
    expect(codex.origins['agents.explorer.effort']).toBeUndefined()
  })

  test('unknown profile reports the active selector source and known names', async () => {
    expect(rejected(await load({ profile: 'nope' }))).toBe('u: profile: unknown profile "nope"; known: claude, codex, mixed')
    expect(rejected(await load({}, { profile: 'nope', profiles: { mine: {} } })))
      .toBe('p: profile: unknown profile "nope"; known: claude, codex, mixed, mine')
  })

  test('top-level model, effort and engine moved to profiles', async () => {
    for (const field of ['model', 'effort', 'engine']) {
      for (const profile of [undefined, 'mixed']) {
        const target = profile ?? 'claude'
        expect(rejected(await load({ profile, agents: { fixer: { [field]: 'x' } } })))
          .toContain(`agents.fixer.${field}: moved to profiles.${target}.agents.fixer.${field}`)
        expect(rejected(await load({ profile, council: { seats: { beta: { [field]: 'x' } } } })))
          .toContain(`council.seats.beta.${field}: moved to profiles.${target}.council.seats.beta.${field}`)
      }
    }
    expect(rejected(await load({ profile: 'mixed' }, { agents: { fixer: { model: 'x' } } })))
      .toContain('moved to profiles.claude.agents.fixer.model')
  })

  test('top-level sandbox and prompt accepted for every role', async () => {
    const result = valid(await load({ agents: { oracle: { sandbox: 'workspace-write', prompt: 'x' }, designer: { sandbox: 'read-only' } } }))
    expect(result.config.agents.oracle.sandbox).toBe('workspace-write')
    expect(result.config.agents.oracle.prompt).toBe('x')
    expect(result.config.agents.designer.sandbox).toBe('read-only')
  })

  test('engine/model pairs both ways and Claude suffixes', async () => {
    expect(rejected(await load({ profiles: { claude: { agents: { fixer: { model: 'gpt-6-astra' } } } } })))
      .toBe('u: profiles.claude.agents.fixer.model: "gpt-6-astra" is not a Claude model (engine claude)')
    expect(rejected(await load({ profile: 'mixed', profiles: { mixed: { council: { seats: { alpha: { model: 'opus' } } } } } })))
      .toBe('u: profiles.mixed.council.seats.alpha.model: "opus" is a Claude model (engine codex)')
    expect(valid(await load({ profiles: { claude: { agents: { fixer: { model: 'opus[1m]' } } } } })).config.agents.fixer.model).toBe('opus[1m]')
  })

  test('inactive profiles are validated after all layers', async () => {
    const user = { profile: 'claude', profiles: { codex: { agents: { oracle: { model: 'opus' } } } } }
    expect(rejected(await load(user))).toContain('profiles.codex.agents.oracle.model')
    expect((await load(user, { profiles: { codex: { agents: { oracle: { model: 'gpt-6-astra' } } } } })).ok).toBe(true)
  })

  test('post-merge error prefix is the file that set the field', async () => {
    expect(rejected(await load({}, { profiles: { claude: { agents: { fixer: { model: 'gpt-6-astra' } } } } })))
      .toBe('p: profiles.claude.agents.fixer.model: "gpt-6-astra" is not a Claude model (engine claude)')
    expect(rejected(await load({ profiles: { mine: { agents: { oracle: { model: 'gpt-6-astra' } } } } }, { profile: 'mine' })))
      .toBe('u: profiles.mine.agents.oracle.model: "gpt-6-astra" is not a Claude model (engine claude)')
  })

  test('new seat needs an engine, which can be supplied by a later layer', async () => {
    const user = { profiles: { claude: { council: { seats: { gamma: { model: 'opus' } } } } } }
    expect(rejected(await load(user))).toContain('council.seats.gamma.engine')
    const result = valid(await load(user, { profiles: { claude: { council: { seats: { gamma: { engine: 'claude' } } } } } }))
    expect(result.config.council.seats.gamma).toEqual({ engine: 'claude', model: 'opus' })
    expect(rejected(await load({ council: { seats: { gamma: { prompt: 'x' } } } })))
      .toBe('u: council.seats.gamma.engine: required; declare it in profiles.claude.council.seats.gamma')
    expect(rejected(await load({ profiles: { claude: { council: { seats: { gamma: {} } } } } })))
      .toContain('u: profiles.claude.council.seats.gamma.engine')
  })

  test('top-level seat may be declared by a profile in the project', async () => {
    const result = valid(await load({ council: { seats: { gamma: { prompt: 'x' } } } }, {
      profiles: { claude: { council: { seats: { gamma: { engine: 'codex' } } } } },
    }))
    expect(result.config.council.seats.gamma).toEqual({ engine: 'codex', prompt: 'x' })
  })

  test('origins project only the active profile', async () => {
    const profiles = { mixed: { agents: { fixer: { model: 'gpt-6-astra' } } } }
    const codex = valid(await load({ profiles }, { profile: 'codex' }))
    expect(codex.origins['agents.fixer.model']).toBe('default')
    expect(codex.origins.profile).toBe('project')
    expect(Object.keys(codex.origins).some(key => key.startsWith('profiles.'))).toBe(false)
    expect(Object.hasOwn(codex.config, 'profiles')).toBe(false)
    const mixed = valid(await load({ profile: 'mixed', profiles }))
    expect(mixed.origins['agents.fixer.model']).toBe('user')
    expect(mixed.origins.profile).toBe('user')
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
  test('default profile is claude and equals DEFAULT_CONFIG', async () => {
    const result = valid(await loadConfig(async () => undefined, { user: 'u' }))
    expect(result.config).toEqual(DEFAULT_CONFIG)
    expect(result.config.sandboxCap).toBe('workspace-write')
    expect(result.config.profile).toBe('claude')
    expect(result.config.agents).toEqual({
      explorer: { engine: 'claude', model: 'haiku', sandbox: 'read-only' },
      librarian: { engine: 'claude', model: 'haiku', sandbox: 'read-only' },
      fixer: { engine: 'claude', model: 'sonnet', sandbox: 'workspace-write' },
      oracle: { engine: 'claude', model: 'opus', sandbox: 'read-only' },
      designer: { engine: 'claude', model: 'sonnet', sandbox: 'workspace-write' },
    })
    expect(result.config.council.seats).toEqual({
      alpha: { engine: 'claude', model: 'opus' }, beta: { engine: 'claude', model: 'sonnet' },
    })
    expect(result.origins.profile).toBe('default')
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
      profile: 'mixed',
      foregroundMinutes: 2,
      disabledAgents: ['oracle', 'oracle'],
      agents: { fixer: { prompt: 'user prompt' } },
      council: { seats: { alpha: { prompt: 'seat prompt' } } },
      profiles: { mixed: {
        agents: { fixer: { model: 'user-model', effort: 'high' } },
        council: { seats: { alpha: { engine: 'codex', model: 'user-seat' } } },
      } },
    }, {
      foregroundMinutes: 3,
      disabledAgents: ['council', 'oracle'],
      agents: { fixer: { sandbox: 'read-only' } },
      profiles: { mixed: {
        agents: { fixer: { model: 'project-model' } },
        council: { seats: { alpha: { engine: 'claude', effort: 'low' }, gamma: { engine: 'codex' } } },
      } },
    }))
    expect(result.config.foregroundMinutes).toBe(3)
    expect(result.config.disabledAgents).toEqual(['oracle', 'council'])
    expect(result.config.agents.fixer).toEqual({
      engine: 'codex', model: 'project-model', sandbox: 'read-only', effort: 'high', prompt: 'user prompt',
    })
    expect(result.config.agents.explorer).toEqual({ engine: 'codex', model: 'gpt-6-luna', effort: 'high', sandbox: 'read-only' })
    expect(result.config.council.seats).toEqual({
      alpha: { engine: 'claude', effort: 'low', prompt: 'seat prompt' },
      beta: { engine: 'claude', model: 'opus' },
      gamma: { engine: 'codex' },
    })
  })

  test('accepts custom prompts for native roles and disabled councillors', async () => {
    const result = valid(await load({
      disabledAgents: ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'council', 'councillor:alpha'],
      agents: { oracle: { prompt: '' }, designer: { prompt: 'custom' } },
      profiles: { claude: { agents: { oracle: { model: 'sonnet', effort: 'high' } } } },
    }))
    expect(result.config.agents.oracle).toEqual({ engine: 'claude', model: 'sonnet', effort: 'high', prompt: '', sandbox: 'read-only' })
    expect(result.config.agents.designer).toEqual({ engine: 'claude', model: 'sonnet', prompt: 'custom', sandbox: 'workspace-write' })
    expect(result.config.disabledAgents).toContain('councillor:alpha')
  })

  test('origins report where each field came from', async () => {
    const result = valid(await load({
      profile: 'mixed',
      profiles: { mixed: {
        agents: { fixer: { model: 'user-model', effort: 'high' } },
        council: { seats: { alpha: { engine: 'codex' } } },
      } },
      council: { seats: { alpha: { prompt: 'extra' } } },
    }, {
      foregroundMinutes: 8,
      disabledAgents: ['council'],
      profiles: { mixed: { agents: { fixer: { model: 'project-model' } } } },
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
    ['unknown seat field', '{"council":{"seats":{"alpha":{"sandbox":"read-only"}}}}', 'council.seats.alpha.sandbox'],
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
    ['non string model', '{"profiles":{"claude":{"agents":{"fixer":{"model":2}}}}}', 'agents.fixer.model'],
    ['non string effort', '{"profiles":{"claude":{"agents":{"oracle":{"effort":true}}}}}', 'agents.oracle.effort'],
    ['non string prompt', '{"agents":{"designer":{"prompt":[]}}}', 'agents.designer.prompt'],
    ['invalid role sandbox', '{"agents":{"fixer":{"sandbox":"other"}}}', 'agents.fixer.sandbox'],
    ['non object council', '{"council":false}', 'council'],
    ['non object seats', '{"council":{"seats":[]}}', 'council.seats'],
    ['null seat', '{"council":{"seats":{"gamma":null}}}', 'council.seats.gamma'],
    ['missing engine on a new seat', '{"profiles":{"claude":{"council":{"seats":{"gamma":{"model":"opus"}}}}}}', 'council.seats.gamma.engine'],
    ['invalid seat engine', '{"profiles":{"claude":{"council":{"seats":{"alpha":{"engine":"other"}}}}}}', 'council.seats.alpha.engine'],
    ['non string seat model', '{"profiles":{"claude":{"council":{"seats":{"alpha":{"model":2}}}}}}', 'council.seats.alpha.model'],
    ['non string seat effort', '{"profiles":{"claude":{"council":{"seats":{"alpha":{"effort":null}}}}}}', 'council.seats.alpha.effort'],
    ['non string seat prompt', '{"council":{"seats":{"alpha":{"prompt":false}}}}', 'council.seats.alpha.prompt'],
    ['empty profile', '{"profile":" "}', 'profile'],
    ['non string profile', '{"profile":2}', 'profile'],
    ['non object profiles', '{"profiles":[]}', 'profiles'],
    ['null profile', '{"profiles":{"mine":null}}', 'profiles.mine'],
    ['unknown profile field', '{"profiles":{"mine":{"sandboxCap":"read-only"}}}', 'profiles.mine.sandboxCap'],
    ['unknown profile role', '{"profiles":{"mine":{"agents":{"other":{}}}}}', 'profiles.mine.agents.other'],
    ['profile prompt', '{"profiles":{"mine":{"agents":{"oracle":{"prompt":"x"}}}}}', 'profiles.mine.agents.oracle.prompt'],
    ['profile sandbox', '{"profiles":{"mine":{"agents":{"oracle":{"sandbox":"read-only"}}}}}', 'profiles.mine.agents.oracle.sandbox'],
    ['invalid role engine', '{"profiles":{"mine":{"agents":{"oracle":{"engine":"other"}}}}}', 'profiles.mine.agents.oracle.engine'],
    ['unknown profile council field', '{"profiles":{"mine":{"council":{"enabled":true}}}}', 'profiles.mine.council.enabled'],
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
    const first = valid(await load({ profiles: { claude: { agents: { fixer: { effort: 'high' } } } } }))
    first.config.disabledAgents.push('oracle')
    first.config.agents.fixer.model = 'mutated'
    first.config.council.seats.alpha!.model = 'mutated'
    const second = valid(await loadConfig(async () => undefined, { user: 'u' }, first.config))
    expect(second.config.disabledAgents).toEqual([])
    expect(second.config.agents.fixer).toEqual({ engine: 'claude', model: 'sonnet', sandbox: 'workspace-write' })
    expect(second.config.council.seats.alpha?.model).toBe('opus')
    expect(DEFAULT_CONFIG.agents.fixer.model).toBe('sonnet')
    expect(DEFAULT_CONFIG.council.seats.alpha?.model).toBe('opus')
    expect(DEFAULT_CONFIG.disabledAgents).toEqual([])
  })
})

test('partial override of an existing seat keeps its engine', async () => {
  const result = await load({ profile: 'mixed', profiles: { mixed: { council: { seats: { alpha: { effort: 'low' } } } } } })
  expect(result.ok).toBe(true)
  expect(result.config.council.seats.alpha).toEqual({ engine: 'codex', model: 'gpt-6-astra', effort: 'low' })
})
