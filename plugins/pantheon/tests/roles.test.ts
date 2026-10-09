import { describe, expect, test } from 'claude-code/testing'
import { MIXED } from './fixtures/profiles'
import { CODEX_ROLES, NATIVE_ROLES, nativeAgentSpecs, resolveCodexCall } from '../hooks/roles'
import type { CodexCall, PantheonConfig, RolePrompts, Sandbox } from '../hooks/types'

const ctx = { cwd: '/repo/sub', skipGitRepoCheck: false }
const prompts: RolePrompts = key => `<${key}>`

function call(config: PantheonConfig, agent = 'fixer'): CodexCall {
  const result = resolveCodexCall(config, { agent, prompt: 'task' }, ctx, prompts)
  if ('error' in result) throw new Error(result.error)
  return result
}

describe('Codex roles', () => {
  test('fixed role groups resolve through their own engine', () => {
    for (const agent of CODEX_ROLES) {
      expect(call(MIXED, agent).agent).toBe(agent)
    }
    for (const agent of NATIVE_ROLES) {
      expect(resolveCodexCall(MIXED, { agent, prompt: 'task' }, ctx, prompts))
        .toEqual({ error: expect.stringContaining(`pantheon:${agent}`) })
    }
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
