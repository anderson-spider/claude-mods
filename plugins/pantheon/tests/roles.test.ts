import { describe, expect, test } from 'claude-code/testing'
import { DEFAULTS, resolved } from './fixtures/config'
import { activeSeats, nativeAgentSpecs, seatDisabled } from '../hooks/roles'
import { rolePrompt } from '../hooks/prompts/roles'
import { ROLES } from '../hooks/defaults'
import type { PantheonConfig, RolePrompts } from '../hooks/types'

const prompts: RolePrompts = key => `<${key}>`
const NO_DELEGATION = ['Agent']
const NO_EDITS = ['Edit', 'Write', 'NotebookEdit']

describe('native agent prompts', () => {
  test('explorer and librarian may use Bash and MCP; oracle and councillor may not change state', () => {
    expect(rolePrompt('explorer')).toContain('Bash')
    expect(rolePrompt('explorer')).toContain('MCP')
    const librarian = rolePrompt('librarian')
    expect(librarian).toContain('terminal-browser action --browser <key>')
    expect(librarian).toContain('done')
    for (const key of ['oracle', 'councillor'] as const) {
      expect(rolePrompt(key)).toContain('including through Bash')
    }
  })
})

describe('native agent specs', () => {
  test('git inherits file editing tools but cannot delegate', () => {
    const spec = nativeAgentSpecs(DEFAULTS, prompts).find(spec => spec.name === 'git')
    expect(spec?.disallowedTools).toEqual(NO_DELEGATION)
    expect(spec).not.toHaveProperty('tools')
    expect(spec?.description).toContain('commit, squash, push, PR/MR, checkout, worktree, stash')
    expect(spec?.prompt).toBe('<git>')
    expect(spec?.model).toBe('haiku')
  })

  test('every role and seat is a native spec', () => {
    const specs = nativeAgentSpecs(DEFAULTS, prompts)
    expect(specs.map(spec => spec.name)).toEqual([...ROLES, 'councillor-alpha', 'councillor-beta'])
    expect(specs.find(spec => spec.name === 'explorer')).toEqual(expect.objectContaining({
      description: 'Pantheon codebase recon that returns compressed context.', model: 'haiku',
    }))
    expect(specs.find(spec => spec.name === 'explorer')?.disallowedTools).toEqual(NO_DELEGATION)
    expect(specs.find(spec => spec.name === 'librarian')?.disallowedTools).toEqual(NO_DELEGATION)
    for (const name of ['oracle', 'councillor-alpha', 'councillor-beta']) {
      expect(specs.find(spec => spec.name === name)?.disallowedTools).toEqual([...NO_EDITS, ...NO_DELEGATION])
    }
    expect(specs.find(spec => spec.name === 'librarian')).toEqual(expect.objectContaining({
      description: 'Pantheon research on external docs and APIs.',
    }))
    expect(specs.find(spec => spec.name === 'executor')).toEqual(expect.objectContaining({
      model: 'sonnet', description: 'Pantheon bounded implementation from a complete specification.',
    }))
    expect(specs.find(spec => spec.name === 'executor')).not.toHaveProperty('disallowedTools')
    for (const spec of specs) expect(spec).not.toHaveProperty('tools')
  })

  test('default models reach the specs', () => {
    const models = Object.fromEntries(nativeAgentSpecs(DEFAULTS, prompts).map(spec => [spec.name, spec.model]))
    expect(models).toEqual({
      explorer: 'haiku', librarian: 'haiku', executor: 'sonnet', oracle: 'opus', designer: 'sonnet', git: 'haiku',
      'councillor-alpha': 'opus', 'councillor-beta': 'sonnet',
    })
  })

  test('oracle and seats inherit tools minus file edits; designer inherits tools', () => {
    const specs = nativeAgentSpecs(DEFAULTS, prompts)
    expect(specs.find(spec => spec.name === 'oracle')).toEqual(expect.objectContaining({
      prompt: '<oracle>', model: 'opus', disallowedTools: [...NO_EDITS, ...NO_DELEGATION], description: expect.any(String),
    }))
    expect(specs.find(spec => spec.name === 'designer')).toEqual(expect.objectContaining({ prompt: '<designer>', model: 'sonnet' }))
    expect(specs.find(spec => spec.name === 'designer')).not.toHaveProperty('disallowedTools')
    expect(specs.find(spec => spec.name === 'councillor-beta')).toEqual(expect.objectContaining({
      prompt: '<councillor>', model: 'sonnet', disallowedTools: [...NO_EDITS, ...NO_DELEGATION],
    }))
  })

  test('config model, effort and append prompts reach the registration specs', async () => {
    const config = await resolved({
      agents: { oracle: { model: 'claude-opus-4-1', effort: 'high', prompt: 'extra' } },
      council: { seats: { beta: { model: 'haiku', effort: 'low', prompt: 'seat extra' }, gamma: { prompt: 'g' } } },
    })
    const specs = nativeAgentSpecs(config, prompts)
    expect(specs.find(spec => spec.name === 'oracle')).toEqual(expect.objectContaining({
      prompt: '<oracle>\n\nextra', model: 'claude-opus-4-1', effort: 'high', disallowedTools: [...NO_EDITS, ...NO_DELEGATION],
    }))
    expect(specs.find(spec => spec.name === 'councillor-beta')).toEqual(expect.objectContaining({
      prompt: '<councillor>\n\nseat extra', model: 'haiku', effort: 'low',
    }))
    const gamma = specs.find(spec => spec.name === 'councillor-gamma')
    expect(gamma?.prompt).toBe('<councillor>\n\ng')
    expect(gamma?.model).toBeUndefined()
  })

  test('disabled natives and council do not produce registration specs', () => {
    expect(nativeAgentSpecs({ ...DEFAULTS, disabledAgents: ['oracle', 'council'] }, prompts)
      .map(spec => spec.name)).toEqual(['explorer', 'librarian', 'executor', 'designer', 'git'])
    expect(nativeAgentSpecs({ ...DEFAULTS, disabledAgents: ['councillor:beta'] }, prompts)
      .map(spec => spec.name)).toEqual([...ROLES, 'councillor-alpha'])
    expect(nativeAgentSpecs({ ...DEFAULTS, disabledAgents: ['councillor-alpha'] }, prompts)
      .map(spec => spec.name)).toEqual([...ROLES, 'councillor-beta'])
  })

  test('prompts come from the injected function', () => {
    const marked: RolePrompts = key => `[${key}]`
    expect(nativeAgentSpecs(DEFAULTS, marked).find(spec => spec.name === 'explorer')?.prompt).toBe('[explorer]')
  })
})

describe('council seats', () => {
  test('seats are active unless the council or the seat is disabled, sorted by name', () => {
    const config: PantheonConfig = { ...DEFAULTS, council: { seats: { zeta: {}, alpha: {}, mid: {} } } }
    expect(activeSeats(config)).toEqual(['alpha', 'mid', 'zeta'])
    expect(activeSeats({ ...config, disabledAgents: ['councillor:mid'] })).toEqual(['alpha', 'zeta'])
    expect(activeSeats({ ...config, disabledAgents: ['councillor-alpha'] })).toEqual(['mid', 'zeta'])
    expect(activeSeats({ ...config, disabledAgents: ['council'] })).toEqual([])
    expect(seatDisabled({ ...config, disabledAgents: ['council'] }, 'alpha')).toBe(true)
    expect(seatDisabled(config, 'alpha')).toBe(false)
  })
})

describe('role prompts', () => {
  test('executor executes the brief and reports results within its boundaries', () => {
    const prompt = rolePrompt('executor')
    for (const text of [
      'run scripts, test batteries and API calls',
      "within the orchestrator's complete brief and assigned scope",
      'short result: a table, status or errors, not raw logs',
      'State what you ran and what you did not run.',
      'Do not do external research.',
      'Do not spawn subagents or delegate work; return coordination needs to the orchestrator.',
      'Never modify protected branches or rewrite git history; git operations stay with the git role.',
    ]) expect(prompt).toContain(text)
  })

  test('designer, executor and git return coordination to the orchestrator', () => {
    for (const role of ['designer', 'executor', 'git'] as const) {
      expect(rolePrompt(role)).toContain('Do not spawn subagents or delegate work; return coordination needs to the orchestrator.')
    }
  })

  test('executor does not commit and leaves that to the git role', () => {
    expect(rolePrompt('executor')).toContain('Do not commit or push; the git role handles your delivered changes.')
    expect(rolePrompt('executor')).not.toContain('.git is read-only')
  })

  test('git covers checkout, switch, worktree and stash', () => {
    const prompt = rolePrompt('git')
    for (const text of ['checkout', 'switch', 'worktree', 'stash']) expect(prompt).toContain(text)
  })

  test('read-only instructions use the native tools', () => {
    for (const key of ['explorer', 'librarian', 'oracle', 'councillor'] as const) {
      expect(rolePrompt(key)).toContain('Read/Grep/Glob')
      expect(rolePrompt(key)).not.toContain('apply_patch')
      expect(rolePrompt(key)).not.toContain('rg --files')
    }
    expect(rolePrompt('librarian')).toContain('WebSearch')
    expect(rolePrompt('librarian')).toContain('WebFetch')
  })

  test('write roles describe file operations', () => {
    for (const key of ['executor', 'designer', 'git'] as const) {
      expect(rolePrompt(key)).toContain('**File operations**')
      expect(rolePrompt(key)).toContain('Read/Grep/Glob/Edit')
      expect(rolePrompt(key)).not.toContain('apply_patch')
    }
  })

  test('no prompt mentions Codex, delegate tools or sandboxes', () => {
    for (const key of [...ROLES, 'councillor'] as const) {
      const prompt = rolePrompt(key)
      expect(prompt).not.toMatch(/codex|delegate_|sandbox/i)
    }
  })

  test('all role prompts end with the report override', () => {
    for (const key of [...ROLES, 'councillor'] as const) {
      expect(rolePrompt(key).endsWith('If the task defines a report format, it replaces the format above.')).toBe(true)
    }
  })
})
