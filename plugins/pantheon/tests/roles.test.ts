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
  test('code-reader and docs-reader may use Bash and MCP; architect and councillor may not change state', () => {
    expect(rolePrompt('code-reader')).toContain('Bash')
    expect(rolePrompt('code-reader')).toContain('MCP')
    const docsReader = rolePrompt('docs-reader')
    expect(docsReader).toContain('terminal-browser action --browser <key>')
    expect(docsReader).toContain('done')
    for (const key of ['architect', 'councillor'] as const) {
      expect(rolePrompt(key)).toContain('including through Bash')
    }
  })
})

describe('native agent specs', () => {
  test('git inherits file editing tools but cannot delegate', () => {
    const spec = nativeAgentSpecs(DEFAULTS, prompts).find(spec => spec.name === 'git')
    expect(spec?.disallowedTools).toEqual(NO_DELEGATION)
    expect(spec).not.toHaveProperty('tools')
    expect(spec?.description).toContain('squash, PR/MR, checkout, switch, worktree, stash')
    expect(spec?.prompt).toBe('<git>')
    expect(spec?.model).toBe('haiku')
  })

  test('every role and seat is a native spec', () => {
    const specs = nativeAgentSpecs(DEFAULTS, prompts)
    expect(specs.map(spec => spec.name)).toEqual([...ROLES, 'councillor-alpha', 'councillor-beta'])
    expect(specs.find(spec => spec.name === 'code-reader')).toEqual(expect.objectContaining({
      description: 'Pantheon codebase recon that returns compressed context.', model: 'haiku',
    }))
    expect(specs.find(spec => spec.name === 'code-reader')?.disallowedTools).toEqual(NO_DELEGATION)
    expect(specs.find(spec => spec.name === 'docs-reader')?.disallowedTools).toEqual(NO_DELEGATION)
    for (const name of ['architect', 'qa', 'councillor-alpha', 'councillor-beta']) {
      expect(specs.find(spec => spec.name === name)?.disallowedTools).toEqual([...NO_EDITS, ...NO_DELEGATION])
    }
    expect(specs.find(spec => spec.name === 'docs-reader')).toEqual(expect.objectContaining({
      description: 'Pantheon research on external docs and APIs.',
    }))
    expect(specs.find(spec => spec.name === 'developer')).toEqual(expect.objectContaining({
      model: 'sonnet', description: 'Pantheon implementation of all code (backend, scripts, tests, hooks, CLI, UI logic) from a complete specification.',
    }))
    expect(specs.find(spec => spec.name === 'developer')).not.toHaveProperty('disallowedTools')
    for (const spec of specs) expect(spec).not.toHaveProperty('tools')
  })

  test('default models reach the specs', () => {
    const models = Object.fromEntries(nativeAgentSpecs(DEFAULTS, prompts).map(spec => [spec.name, spec.model]))
    expect(models).toEqual({
      'code-reader': 'haiku', 'docs-reader': 'haiku', developer: 'sonnet', architect: 'opus', qa: 'sonnet', ux: 'sonnet', git: 'haiku',
      'councillor-alpha': 'opus', 'councillor-beta': 'sonnet',
    })
  })

  test('qa has the read-only tool set, no delegation and its own description', () => {
    const qa = nativeAgentSpecs(DEFAULTS, prompts).find(spec => spec.name === 'qa')
    expect(qa).toEqual(expect.objectContaining({
      prompt: '<qa>', model: 'sonnet', disallowedTools: [...NO_EDITS, ...NO_DELEGATION],
      description: 'Runs what was built and returns a pass/fail verdict per acceptance criterion, with evidence.',
    }))
    expect(qa).not.toHaveProperty('tools')
  })

  test('architect and seats inherit tools minus file edits; ux inherits tools', () => {
    const specs = nativeAgentSpecs(DEFAULTS, prompts)
    expect(specs.find(spec => spec.name === 'architect')).toEqual(expect.objectContaining({
      prompt: '<architect>', model: 'opus', disallowedTools: [...NO_EDITS, ...NO_DELEGATION], description: expect.any(String),
    }))
    expect(specs.find(spec => spec.name === 'ux')).toEqual(expect.objectContaining({ prompt: '<ux>', model: 'sonnet' }))
    expect(specs.find(spec => spec.name === 'ux')).not.toHaveProperty('disallowedTools')
    expect(specs.find(spec => spec.name === 'councillor-beta')).toEqual(expect.objectContaining({
      prompt: '<councillor>', model: 'sonnet', disallowedTools: [...NO_EDITS, ...NO_DELEGATION],
    }))
  })

  test('config model, effort and append prompts reach the registration specs', async () => {
    const config = await resolved({
      agents: { architect: { model: 'claude-opus-4-1', effort: 'high', prompt: 'extra' } },
      council: { seats: { beta: { model: 'haiku', effort: 'low', prompt: 'seat extra' }, gamma: { prompt: 'g' } } },
    })
    const specs = nativeAgentSpecs(config, prompts)
    expect(specs.find(spec => spec.name === 'architect')).toEqual(expect.objectContaining({
      prompt: '<architect>\n\nextra', model: 'claude-opus-4-1', effort: 'high', disallowedTools: [...NO_EDITS, ...NO_DELEGATION],
    }))
    expect(specs.find(spec => spec.name === 'councillor-beta')).toEqual(expect.objectContaining({
      prompt: '<councillor>\n\nseat extra', model: 'haiku', effort: 'low',
    }))
    const gamma = specs.find(spec => spec.name === 'councillor-gamma')
    expect(gamma?.prompt).toBe('<councillor>\n\ng')
    expect(gamma?.model).toBeUndefined()
  })

  test('disabled natives and council do not produce registration specs', () => {
    expect(nativeAgentSpecs({ ...DEFAULTS, disabledAgents: ['architect', 'council'] }, prompts)
      .map(spec => spec.name)).toEqual(['code-reader', 'docs-reader', 'developer', 'qa', 'ux', 'git'])
    expect(nativeAgentSpecs({ ...DEFAULTS, disabledAgents: ['councillor:beta'] }, prompts)
      .map(spec => spec.name)).toEqual([...ROLES, 'councillor-alpha'])
    expect(nativeAgentSpecs({ ...DEFAULTS, disabledAgents: ['councillor-alpha'] }, prompts)
      .map(spec => spec.name)).toEqual([...ROLES, 'councillor-beta'])
  })

  test('prompts come from the injected function', () => {
    const marked: RolePrompts = key => `[${key}]`
    expect(nativeAgentSpecs(DEFAULTS, marked).find(spec => spec.name === 'code-reader')?.prompt).toBe('[code-reader]')
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
  test('developer executes the brief and reports results within its boundaries', () => {
    const prompt = rolePrompt('developer')
    for (const text of [
      'run scripts, test batteries and API calls',
      "within the lead's complete brief and assigned scope",
      'short result: a table, status or errors, not raw logs',
      'State what you ran and what you did not run.',
      'Do not do external research.',
      'Do not spawn subagents or delegate work; return coordination needs to the lead.',
      'Never modify protected branches or rewrite git history; other git operations stay with the git role.',
    ]) expect(prompt).toContain(text)
  })

  test('ux, developer and git return coordination to the lead', () => {
    for (const role of ['ux', 'developer', 'git'] as const) {
      expect(rolePrompt(role)).toContain('Do not spawn subagents or delegate work; return coordination needs to the lead.')
    }
  })

  test('developer writes all code, UI code included, and only guides look-and-feel work to ux', () => {
    const prompt = rolePrompt('developer')
    expect(prompt).toContain('Write all the code (backend, scripts, tests, hooks, CLI, UI code and logic included)')
    expect(prompt).toContain('tell the lead it belongs to ux. This is guidance, not a refusal: still do the code your brief assigns.')
    expect(prompt).not.toContain('No UI files')
    expect(prompt).not.toContain('No design work')
  })

  test('ux owns look and feel, implements it and keeps the design criteria', () => {
    const prompt = rolePrompt('ux')
    for (const text of ['Own the look and feel: layout, hierarchy, color, spacing, motion, affordances and UI copy', 'Implement them (do not only advise)', 'whichever files your brief or task assigns', '## Design Principles', '## Review Responsibilities', 'Typography']) {
      expect(prompt).toContain(text)
    }
  })

  test('qa can say blocked instead of fail when it cannot verify, and says why', () => {
    const prompt = rolePrompt('qa')
    for (const text of ['QA: blocked — <why', 'environment is unavailable', 'a criterion that needs a side effect', 'that is `blocked`, not `fail`', 'finish with `QA: blocked`']) {
      expect(prompt).toContain(text)
    }
    expect(prompt).not.toContain('mark it `fail` and say why it could not be run')
  })

  test('architect ends a task review with one REVIEW: pass|fail line and gives a diagnosis without it', () => {
    const prompt = rolePrompt('architect')
    for (const text of ['End your answer with exactly one final line', '`REVIEW: pass` or `REVIEW: fail`', 'and nothing after it', 'diagnose a task that keeps failing', 'no `REVIEW:` line']) {
      expect(prompt).toContain(text)
    }
    expect(rolePrompt('councillor')).not.toContain('REVIEW:')
  })

  test('docs-reader reads and researches without writing docs', () => {
    expect(rolePrompt('docs-reader')).toContain('you do not write documentation')
  })

  test('developer commits only its own paths and leaves push and other git work out', () => {
    const prompt = rolePrompt('developer')
    expect(prompt).toContain('git add -- <paths>')
    expect(prompt).toContain('the lead pushes and the git role handles the rest')
    expect(prompt).not.toContain('.git is read-only')
  })

  test('git covers checkout, switch, worktree and stash', () => {
    const prompt = rolePrompt('git')
    for (const text of ['checkout', 'switch', 'worktree', 'stash']) expect(prompt).toContain(text)
  })

  test('read-only instructions use the native tools', () => {
    for (const key of ['code-reader', 'docs-reader', 'architect', 'councillor'] as const) {
      expect(rolePrompt(key)).toContain('Read/Grep/Glob')
      expect(rolePrompt(key)).not.toContain('apply_patch')
      expect(rolePrompt(key)).not.toContain('rg --files')
    }
    expect(rolePrompt('docs-reader')).toContain('WebSearch')
    expect(rolePrompt('docs-reader')).toContain('WebFetch')
  })

  test('write roles describe file operations', () => {
    for (const key of ['developer', 'ux', 'git'] as const) {
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
