import { describe, expect, test } from 'claude-code/testing'
import { CLAUDE, CODEX, MIXED, resolved } from './fixtures/profiles'
import { codexAgents, nativeAgentSpecs, resolveCodexCall, usesCodex } from '../hooks/roles'
import { rolePrompt } from '../hooks/prompts/roles'
import { ROLES } from '../hooks/defaults'
import type { CodexCall, PantheonConfig, RolePrompts, Sandbox } from '../hooks/types'

const ctx = { cwd: '/repo/sub', skipGitRepoCheck: false }
const prompts: RolePrompts = key => `<${key}>`

function call(config: PantheonConfig, agent = 'fixer'): CodexCall {
  const result = resolveCodexCall(config, { agent, prompt: 'task' }, ctx, prompts)
  if ('error' in result) throw new Error(result.error)
  return result
}

describe('Codex roles', () => {
  test('roles route by engine', async () => {
    const codex = await resolved('codex')
    expect(call(codex, 'oracle').sandbox).toBe('read-only')
    expect(call(codex, 'designer').sandbox).toBe('workspace-write')
    expect(call(codex, 'explorer').model).toBe('gpt-6-luna')
    const claude = await resolved('claude')
    expect(resolveCodexCall(claude, { agent: 'explorer', prompt: 't' }, ctx, prompts))
      .toEqual({ error: 'Use pantheon:explorer through the Agent tool.' })
  })

  test('sandbox never widens', async () => {
    expect(call(await resolved('codex', { agents: { oracle: { sandbox: 'workspace-write' } } }), 'oracle').sandbox)
      .toBe('read-only')
    expect(call(await resolved('mixed', { agents: { explorer: { sandbox: 'workspace-write' } } }), 'explorer').sandbox)
      .toBe('read-only')
    expect(call(await resolved('mixed', { agents: { fixer: { sandbox: 'read-only' } } })).sandbox).toBe('read-only')
    expect(call(await resolved('mixed', { sandboxCap: 'read-only' })).sandbox).toBe('read-only')
    for (const seat of ['alpha', 'beta']) expect(call(CODEX, `councillor:${seat}`).sandbox).toBe('read-only')
  })

  test('per-call and configured models must fit the Codex engine for roles and seats', () => {
    for (const agent of ['fixer', 'councillor:alpha']) {
      expect(resolveCodexCall(MIXED, { agent, prompt: 't', model: 'sonnet' }, ctx, prompts))
        .toEqual({ error: expect.stringContaining('"sonnet" is a Claude model (engine codex)') })
    }
    const config: PantheonConfig = {
      ...MIXED, agents: { ...MIXED.agents, fixer: { engine: 'codex', model: 'sonnet' } },
    }
    expect(resolveCodexCall(config, { agent: 'fixer', prompt: 't' }, ctx, prompts))
      .toEqual({ error: expect.stringContaining('"sonnet" is a Claude model (engine codex)') })
    expect(resolveCodexCall(config, { agent: 'fixer', prompt: 't', model: 'gpt-6-luna' }, ctx, prompts))
      .toEqual(expect.objectContaining({ model: 'gpt-6-luna' }))
  })

  test('unknown agent lists Codex agents', () => {
    expect(resolveCodexCall(CLAUDE, { agent: 'nope', prompt: 't' }, ctx, prompts))
      .toEqual({ error: 'Unknown or disabled agent: nope. Valid agents: none.' })
    expect(resolveCodexCall(MIXED, { agent: 'nope', prompt: 't' }, ctx, prompts))
      .toEqual({ error: 'Unknown or disabled agent: nope. Valid agents: explorer, librarian, fixer, councillor:alpha.' })
  })

  test('Codex availability follows active roles and seats', () => {
    expect(codexAgents(CLAUDE)).toEqual([])
    expect(usesCodex(CLAUDE)).toBe(false)
    expect(codexAgents(MIXED)).toEqual(['explorer', 'librarian', 'fixer', 'councillor:alpha'])
    expect(codexAgents(CODEX)).toEqual([...ROLES, 'councillor:alpha', 'councillor:beta'])
    expect(usesCodex(CODEX)).toBe(true)
    expect(usesCodex({ ...MIXED, disabledAgents: ['explorer', 'librarian', 'fixer', 'council'] })).toBe(false)
    expect(codexAgents({ ...MIXED, disabledAgents: ['explorer', 'librarian', 'fixer'] })).toEqual(['councillor:alpha'])
    expect(usesCodex({ ...MIXED, disabledAgents: ['explorer', 'librarian', 'fixer'] })).toBe(true)
  })

  const sandboxCases: Array<{ cap: Sandbox; role: Sandbox; expected: Sandbox }> = [
    { cap: 'read-only', role: 'workspace-write', expected: 'read-only' },
    { cap: 'workspace-write', role: 'read-only', expected: 'read-only' },
    { cap: 'workspace-write', role: 'workspace-write', expected: 'workspace-write' },
    { cap: 'read-only', role: 'read-only', expected: 'read-only' },
  ]
  for (const { cap, role, expected } of sandboxCases) {
    test(`role sandbox ${role} capped by ${cap}`, () => {
      const config: PantheonConfig = {
        ...MIXED, sandboxCap: cap,
        agents: { ...MIXED.agents, fixer: { engine: 'codex', sandbox: role } },
      }
      expect(call(config).sandbox).toBe(expected)
    })
  }

  test('missing role sandbox uses the safe role default', () => {
    const config: PantheonConfig = {
      ...MIXED,
      agents: { ...MIXED.agents, explorer: { engine: 'codex' }, librarian: { engine: 'codex' }, fixer: { engine: 'codex' } },
    }
    expect(call(config, 'explorer').sandbox).toBe('read-only')
    expect(call(config, 'librarian').sandbox).toBe('read-only')
    expect(call(config).sandbox).toBe('workspace-write')
    expect(call(config).model).toBeUndefined()
    expect(call(config).effort).toBeUndefined()
  })

  test('call model and effort win over role while context and network are retained', () => {
    const config: PantheonConfig = {
      ...MIXED, noNetwork: true,
      agents: { ...MIXED.agents, fixer: { engine: 'codex', model: 'role-model', effort: 'low', sandbox: 'read-only' } },
    }
    expect(resolveCodexCall(config, { agent: 'fixer', prompt: 'task', model: 'call-model', effort: 'high', cwd: '/other', resume: 'job' },
      { cwd: '/saved', skipGitRepoCheck: true, resumeSessionId: 'session' }, prompts)).toEqual({
      agent: 'fixer', model: 'call-model', effort: 'high', sandbox: 'read-only', noNetwork: true,
      prompt: '<fixer>\n\n---\n\ntask', cwd: '/saved', skipGitRepoCheck: true, resumeSessionId: 'session',
    })
    expect(call(config).model).toBe('role-model')
    expect(call(config).effort).toBe('low')
  })

  test('native role is refused with an Agent tool instruction', () => {
    const result = resolveCodexCall(MIXED, { agent: 'oracle', prompt: 'task' }, ctx, prompts)
    expect(result).toEqual({ error: expect.stringContaining('pantheon:oracle') })
    expect(result).toEqual({ error: expect.stringContaining('Agent') })
  })

  test('disabled and unknown agents list only available Codex agents', () => {
    const config: PantheonConfig = { ...MIXED, disabledAgents: ['fixer', 'librarian'] }
    for (const agent of ['fixer', 'unknown']) {
      const result = resolveCodexCall(config, { agent, prompt: 'task' }, ctx, prompts)
      expect(result).toEqual({ error: expect.stringContaining('explorer') })
      expect(result).toEqual({ error: expect.stringContaining('councillor:alpha') })
      expect(result).not.toEqual({ error: expect.stringContaining('librarian') })
    }
  })

  test('Codex seat uses seat model, effort and the councillor prompt', () => {
    expect(call(MIXED, 'councillor:alpha')).toEqual({
      agent: 'councillor:alpha', model: 'gpt-6-astra', effort: 'high', sandbox: 'read-only', noNetwork: false,
      prompt: '<councillor>\n\n---\n\ntask', ...ctx,
    })
    expect(resolveCodexCall(MIXED,
      { agent: 'councillor:alpha', prompt: 'task', model: 'call-model', effort: 'low' }, ctx, prompts))
      .toEqual(expect.objectContaining({ model: 'call-model', effort: 'low', sandbox: 'read-only' }))
  })

  test('Claude seat is refused with its native Agent tool instruction', () => {
    const result = resolveCodexCall(MIXED, { agent: 'councillor:beta', prompt: 'task' }, ctx, prompts)
    expect(result).toEqual({ error: expect.stringContaining('pantheon:councillor-beta') })
    expect(result).toEqual({ error: expect.stringContaining('Agent') })
  })

  test('council disabled and missing seats cannot delegate', () => {
    const config: PantheonConfig = { ...MIXED, disabledAgents: ['council'] }
    expect(resolveCodexCall(config, { agent: 'councillor:alpha', prompt: 'task' }, ctx, prompts))
      .toEqual({ error: expect.stringContaining('explorer') })
    expect(resolveCodexCall(MIXED, { agent: 'councillor:missing', prompt: 'task' }, ctx, prompts))
      .toEqual({ error: expect.stringContaining('councillor:alpha') })
  })

  test('inherited object properties are not configured seats', () => {
    expect(resolveCodexCall(MIXED, { agent: 'councillor:toString', prompt: 'task' }, ctx, prompts))
      .toEqual({ error: expect.stringContaining('explorer') })
  })

  test('role and seat config prompts precede the task', () => {
    const config: PantheonConfig = {
      ...MIXED,
      agents: { ...MIXED.agents, fixer: { engine: 'codex', prompt: 'extra' } },
      council: { seats: { alpha: { engine: 'codex', prompt: 'seat extra' } } },
    }
    expect(call(config).prompt).toBe('<fixer>\n\nextra\n\n---\n\ntask')
    expect(call(config, 'councillor:alpha').prompt).toBe('<councillor>\n\nseat extra\n\n---\n\ntask')
  })

  test('danger-full-access cannot be resolved as a cap or role sandbox', () => {
    const invalid = 'danger-full-access' as Sandbox
    expect(resolveCodexCall({ ...MIXED, sandboxCap: invalid }, { agent: 'fixer', prompt: 'task' }, ctx, prompts))
      .toEqual({ error: expect.stringContaining('danger-full-access') })
    const config: PantheonConfig = {
      ...MIXED, agents: { ...MIXED.agents, fixer: { engine: 'codex', sandbox: invalid } },
    }
    expect(resolveCodexCall(config, { agent: 'fixer', prompt: 'task' }, ctx, prompts))
      .toEqual({ error: expect.stringContaining('danger-full-access') })
  })
})

describe('native agent specs', () => {
  test('native specs follow the engine', () => {
    const specs = nativeAgentSpecs(CLAUDE, prompts)
    expect(specs.map(spec => spec.name)).toEqual([...ROLES, 'councillor-alpha', 'councillor-beta'])
    expect(specs.find(spec => spec.name === 'explorer')).toEqual(expect.objectContaining({
      tools: ['Read', 'Grep', 'Glob'], description: 'Pantheon codebase recon that returns compressed context.',
    }))
    expect(specs.find(spec => spec.name === 'librarian')).toEqual(expect.objectContaining({
      tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], description: 'Pantheon research on external docs and APIs.',
    }))
    expect(specs.find(spec => spec.name === 'fixer')).toEqual(expect.objectContaining({
      model: 'sonnet', description: 'Pantheon bounded implementation from a complete specification.',
    }))
    expect(specs.find(spec => spec.name === 'fixer')?.tools).toBeUndefined()
    expect(nativeAgentSpecs(CODEX, prompts)).toEqual([])
    expect(nativeAgentSpecs(MIXED, prompts).map(spec => spec.name)).toEqual(['oracle', 'designer', 'councillor-beta'])
  })

  test('prompts get the engine', () => {
    const enginePrompts: RolePrompts = (key, engine) => `<${key}:${engine}>`
    expect(nativeAgentSpecs(CLAUDE, enginePrompts).find(spec => spec.name === 'explorer')?.prompt)
      .toBe('<explorer:claude>')
    expect(resolveCodexCall(CODEX, { agent: 'oracle', prompt: 't' }, ctx, enginePrompts))
      .toEqual(expect.objectContaining({ prompt: '<oracle:codex>\n\n---\n\nt' }))
  })

  test('oracle and Claude seats are read tools only; designer inherits tools', () => {
    const specs = nativeAgentSpecs(MIXED, prompts)
    expect(specs.map(spec => spec.name)).toEqual(['oracle', 'designer', 'councillor-beta'])
    expect(specs.find(spec => spec.name === 'oracle')).toEqual(expect.objectContaining({
      prompt: '<oracle>', model: 'opus', tools: ['Read', 'Grep', 'Glob'], description: expect.any(String),
    }))
    expect(specs.find(spec => spec.name === 'designer')).toEqual(expect.objectContaining({ prompt: '<designer>', model: 'sonnet' }))
    expect(specs.find(spec => spec.name === 'designer')?.tools).toBeUndefined()
    expect(specs.find(spec => spec.name === 'councillor-beta')).toEqual(expect.objectContaining({
      prompt: '<councillor>', model: 'opus', tools: ['Read', 'Grep', 'Glob'],
    }))
  })

  test('native config model, effort and append prompts reach the registration specs', () => {
    const config: PantheonConfig = {
      ...MIXED, sandboxCap: 'read-only', noNetwork: true,
      agents: { ...MIXED.agents, oracle: { engine: 'claude', model: 'native-model', effort: 'high', prompt: 'extra' } },
      council: { seats: { beta: { engine: 'claude', model: 'seat-model', effort: 'low', prompt: 'seat extra' } } },
    }
    const specs = nativeAgentSpecs(config, prompts)
    expect(specs.find(spec => spec.name === 'oracle')).toEqual(expect.objectContaining({
      prompt: '<oracle>\n\nextra', model: 'native-model', effort: 'high', tools: ['Read', 'Grep', 'Glob'],
    }))
    expect(specs.find(spec => spec.name === 'councillor-beta')).toEqual(expect.objectContaining({
      prompt: '<councillor>\n\nseat extra', model: 'seat-model', effort: 'low',
    }))
    expect(specs.find(spec => spec.name === 'designer')?.tools).toBeUndefined()
  })

  test('disabled natives and council do not produce registration specs', () => {
    expect(nativeAgentSpecs({ ...MIXED, disabledAgents: ['oracle', 'council'] }, prompts)
      .map(spec => spec.name)).toEqual(['designer'])
    expect(nativeAgentSpecs({ ...MIXED, disabledAgents: ['councillor:beta'] }, prompts)
      .map(spec => spec.name)).toEqual(['oracle', 'designer'])
  })
})

describe('role prompts by engine', () => {
  for (const role of ['designer', 'fixer'] as const) {
    for (const engine of ['codex', 'claude'] as const) {
      test(`${role} on ${engine} returns coordination to the orchestrator`, () => {
        expect(rolePrompt(role, engine)).toContain('Do not spawn subagents or delegate work; return coordination needs to the orchestrator.')
      })
    }
  }

  test('fixer commit instructions fit its engine', () => {
    expect(rolePrompt('fixer', 'codex')).toContain('.git is read-only')
    expect(rolePrompt('fixer', 'claude')).toContain('Do not commit or push; the orchestrator commits.')
    expect(rolePrompt('fixer', 'claude')).not.toContain('.git is read-only')
  })

  test('read-only instructions fit the engine tools', () => {
    for (const key of ['explorer', 'librarian', 'oracle', 'councillor'] as const) {
      expect(rolePrompt(key, 'codex')).toContain('rg')
      expect(rolePrompt(key, 'codex')).not.toContain('run Bash')
      expect(rolePrompt(key, 'codex')).not.toContain('without Bash')
      expect(rolePrompt(key, 'claude')).toContain('Read/Grep/Glob')
    }
    expect(rolePrompt('librarian', 'claude')).toContain('WebSearch')
    expect(rolePrompt('librarian', 'claude')).toContain('WebFetch')
    expect(rolePrompt('librarian', 'claude')).not.toContain('MCPs de documentação')
  })

  test('write roles describe file operations on both engines', () => {
    for (const key of ['fixer', 'designer'] as const) {
      for (const engine of ['claude', 'codex'] as const) expect(rolePrompt(key, engine)).toContain('**File operations**')
      expect(rolePrompt(key, 'claude')).toContain('Read/Grep/Glob/Edit')
      expect(rolePrompt(key, 'codex')).toContain('apply_patch')
    }
  })

  test('all role and engine prompts end with the report override', () => {
    for (const key of [...ROLES, 'councillor'] as const) {
      for (const engine of ['claude', 'codex'] as const) {
        expect(rolePrompt(key, engine).endsWith('If the task defines a report format, it replaces the format above.')).toBe(true)
      }
    }
  })
})
