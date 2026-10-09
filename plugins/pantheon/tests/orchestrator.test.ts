import { describe, expect, test } from 'claude-code/testing'
import { MIXED, CLAUDE, CODEX, resolved } from './fixtures/profiles'
import type { PromptKey } from '../hooks/types'
import { buildOrchestratorSection } from '../hooks/prompts/orchestrator'
import { rolePrompt } from '../hooks/prompts/roles'

describe('orchestrator budget', () => {
  test('claude prompt stays within 5000 chars', () => {
    expect(buildOrchestratorSection(CLAUDE).length).toBeLessThanOrEqual(5000)
  })
  // Measured after the cut (4946 and 5029 chars) plus 10%.
  test('codex stays within 5441 chars', () => {
    expect(buildOrchestratorSection(CODEX).length).toBeLessThanOrEqual(5441)
  })
  test('mixed stays within 5532 chars', () => {
    expect(buildOrchestratorSection(MIXED).length).toBeLessThanOrEqual(5532)
  })
})

describe('orchestrator section', () => {
  test('claude librarian routing mentions passing and releasing a logged-in terminal-browser', () => {
    expect(buildOrchestratorSection(CLAUDE)).toContain('terminal-browser action --browser <key> done')
    expect(buildOrchestratorSection(MIXED)).not.toContain('--browser <key>')
  })
  test('claude routes every role and seat through Agent without Codex discipline', () => {
    const section = buildOrchestratorSection(CLAUDE)
    for (const role of ['explorer', 'librarian', 'fixer', 'oracle', 'designer']) {
      expect(section).toContain(`Agent({ subagent_type: "pantheon:${role}"`)
    }
    expect(section).toContain('Council seats: Agent pantheon:councillor-alpha, Agent pantheon:councillor-beta')
    for (const text of ['delegate(', 'delegate_result', 'delegate_cancel', 'resume: <jobId>']) {
      expect(section).not.toContain(text)
    }
    for (const text of ['run_in_background: true', 'completion result', 'Stop a native agent', 'Native follow-ups']) {
      expect(section).toContain(text)
    }
  })

  test('codex routes every role and seat through delegate and preserves native discipline', () => {
    const section = buildOrchestratorSection(CODEX)
    for (const role of ['explorer', 'librarian', 'fixer', 'oracle', 'designer']) {
      expect(section).toContain(`delegate({ agent: "${role}"`)
      expect(section).not.toContain(`pantheon:${role}`)
    }
    expect(section).toContain('Council seats: delegate councillor:alpha, delegate councillor:beta')
    expect(section).toContain('run_in_background: true')
    expect(section).toContain('delegate_result')
  })

  test('discipline follows active engines including council-only Codex', async () => {
    const config = await resolved('claude', {
      profiles: { claude: { council: { seats: { alpha: { engine: 'codex' } } } } },
    })
    expect(buildOrchestratorSection(config)).toContain('delegate_result')
    for (const disabledAgents of [['councillor:alpha'], ['council']]) {
      expect(buildOrchestratorSection({ ...config, disabledAgents })).not.toContain('delegate_result')
    }
    expect(buildOrchestratorSection({
      ...MIXED, disabledAgents: ['explorer', 'librarian', 'fixer', 'council'],
    })).not.toContain('delegate_result')
  })

  test('lists active roles with the correct calling tools', () => {
    const section = buildOrchestratorSection(MIXED)
    for (const role of ['explorer', 'librarian', 'fixer']) {
      expect(section).toContain(`@${role}`)
      expect(section).toContain(`delegate({ agent: "${role}"`)
    }
    expect(section).toContain('Agent({ subagent_type: "pantheon:oracle"')
    expect(section).toContain('Agent({ subagent_type: "pantheon:designer"')
  })

  for (const role of ['explorer', 'librarian', 'fixer', 'oracle', 'designer']) {
    test(`disabled ${role} disappears from routing, examples and skill mappings`, () => {
      const section = buildOrchestratorSection({ ...MIXED, disabledAgents: [role] })
      expect(section).not.toContain(`@${role}`)
      expect(section).not.toContain(`pantheon:${role}`)
      expect(section).not.toContain(`agent: "${role}"`)
    })
  }

  test('same config produces the same bytes without mutating it', () => {
    const before = JSON.stringify(MIXED)
    expect(buildOrchestratorSection(MIXED)).toBe(buildOrchestratorSection(MIXED))
    expect(JSON.stringify(MIXED)).toBe(before)
  })

  test('removes unsupported vocabulary and obsolete source sections', () => {
    const section = buildOrchestratorSection(MIXED)
    for (const text of ['task_revive', 'task_message', 'task_status', 'wait_for_user', '`question`', 'marketplace', 'Marketplace', 'Todo Continuity', '<Communication>', 'Permissions:', 'Stats:', '@observer']) {
      expect(section).not.toContain(text)
    }
  })

  test('keeps workflow, background discipline, amendments, handoff and reuse', () => {
    const section = buildOrchestratorSection(MIXED)
    for (const heading of ['## 1. Understand', '## 2. Path Selection', '## 3. Delegation Check', '## 4. Plan and Parallelize', '## 5. Verify', 'Background Task Discipline', 'Active Task Amendments', 'Design Handoff Discipline', 'Session Reuse']) {
      expect(section).toContain(heading)
    }
    for (const text of ['delegate_result', 'delegate_cancel', 'resume', 'jobId', 'background: true', 'run_in_background: true', 'end the turn', 'partial changes', 'Read/Grep/Glob/Edit', 'apply_patch']) {
      expect(section).toContain(text)
    }
  })

  test('ordinary section mentions seats in one line without injecting Council Mode', () => {
    const section = buildOrchestratorSection(MIXED)
    expect(section).toContain('councillor:alpha')
    expect(section).toContain('pantheon:councillor-beta')
    expect(section.split('\n').filter(line => line.includes('councillor')).length).toBe(1)
    expect(section).not.toContain('## Council Mode')
    expect(section).not.toContain('## Council Response')
  })

  test('empty seats do not fabricate a council member', () => {
    const section = buildOrchestratorSection({ ...MIXED, council: { seats: {} } })
    expect(section).not.toContain('councillor')
  })
})

describe('role prompts', () => {
  const keys: PromptKey[] = ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'councillor']
  for (const key of keys) {
    test(`${key} ends with the task report-format override`, () => {
      expect(rolePrompt(key, 'codex').endsWith('If the task defines a report format, it replaces the format above.')).toBe(true)
    })
  }

  test('Codex roles use rg and shell diagnostics with read-only research', () => {
    for (const key of ['explorer', 'librarian'] as const) {
      expect(rolePrompt(key, 'codex')).toContain('rg')
      expect(rolePrompt(key, 'codex')).toContain('READ-ONLY')
      expect(rolePrompt(key, 'codex')).toContain('shell')
    }
    expect(rolePrompt('explorer', 'codex')).toContain('<results>')
    expect(rolePrompt('explorer', 'codex')).not.toContain('ast_grep_search')
    expect(rolePrompt('librarian', 'codex')).toContain('web search and the documentation MCPs available to you')
    expect(rolePrompt('librarian', 'codex')).not.toContain('context7')
    expect(rolePrompt('librarian', 'codex')).not.toContain('gh_grep')
  })

  test('fixer implements within scope, edits with apply_patch and does not commit', () => {
    const prompt = rolePrompt('fixer', 'codex')
    for (const text of ['apply_patch', '<summary>', '<changes>', '<verification>', 'orchestrator', 'commit', 'Do not spawn subagents', 'No design work']) {
      expect(prompt).toContain(text)
    }
  })

  test('native review and council use read-only tools while designer can edit', () => {
    for (const key of ['oracle', 'councillor'] as const) {
      expect(rolePrompt(key, 'claude')).toContain('Read/Grep/Glob')
      expect(rolePrompt(key, 'claude')).toContain('READ-ONLY')
    }
    expect(rolePrompt('designer', 'claude')).toContain('Read/Grep/Glob/Edit')
    expect(rolePrompt('designer', 'claude')).toContain('Typography')
    expect(rolePrompt('designer', 'claude')).toContain('Motion & Interaction')
    expect(rolePrompt('councillor', 'claude')).toContain('independent')
  })
})
