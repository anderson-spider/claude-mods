import { describe, expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG } from '../hooks/defaults'
import type { PromptKey } from '../hooks/types'
import { buildOrchestratorSection } from '../hooks/prompts/orchestrator'
import { rolePrompt } from '../hooks/prompts/roles'

describe('orchestrator section', () => {
  test('lists active roles with the correct calling tools', () => {
    const section = buildOrchestratorSection(DEFAULT_CONFIG)
    for (const role of ['explorer', 'librarian', 'fixer']) {
      expect(section).toContain(`@${role}`)
      expect(section).toContain(`delegate({ agent: "${role}"`)
    }
    expect(section).toContain('Agent({ subagent_type: "pantheon:oracle"')
    expect(section).toContain('Agent({ subagent_type: "pantheon:designer"')
  })

  for (const role of ['explorer', 'librarian', 'fixer', 'oracle', 'designer']) {
    test(`disabled ${role} disappears from routing, examples and skill mappings`, () => {
      const section = buildOrchestratorSection({ ...DEFAULT_CONFIG, disabledAgents: [role] })
      expect(section).not.toContain(`@${role}`)
      expect(section).not.toContain(`pantheon:${role}`)
      expect(section).not.toContain(`agent: "${role}"`)
    })
  }

  test('same config produces the same bytes without mutating it', () => {
    const before = JSON.stringify(DEFAULT_CONFIG)
    expect(buildOrchestratorSection(DEFAULT_CONFIG)).toBe(buildOrchestratorSection(DEFAULT_CONFIG))
    expect(JSON.stringify(DEFAULT_CONFIG)).toBe(before)
  })

  test('removes unsupported vocabulary and obsolete source sections', () => {
    const section = buildOrchestratorSection(DEFAULT_CONFIG)
    for (const text of ['task_revive', 'task_message', 'task_status', 'wait_for_user', '`question`', 'marketplace', 'Marketplace', 'Todo Continuity', '<Communication>', 'Permissions:', 'Stats:', '@observer']) {
      expect(section).not.toContain(text)
    }
  })

  test('keeps workflow, background discipline, amendments, handoff and reuse', () => {
    const section = buildOrchestratorSection(DEFAULT_CONFIG)
    for (const heading of ['## 1. Understand', '## 2. Path Selection', '## 3. Delegation Check', '## 4. Plan and Parallelize', '## 5. Verify', 'Background Task Discipline', 'Active Task Amendments', 'Design Handoff Discipline', 'Session Reuse']) {
      expect(section).toContain(heading)
    }
    for (const text of ['delegate_result', 'delegate_cancel', 'resume', 'jobId', 'background: true', 'run_in_background: true', 'end the turn', 'partial changes', 'Read/Grep/Glob/Edit', 'apply_patch']) {
      expect(section).toContain(text)
    }
  })

  test('ordinary section mentions seats in one line without injecting Council Mode', () => {
    const section = buildOrchestratorSection(DEFAULT_CONFIG)
    expect(section).toContain('councillor:alpha')
    expect(section).toContain('pantheon:councillor-beta')
    expect(section.split('\n').filter(line => line.includes('councillor')).length).toBe(1)
    expect(section).not.toContain('## Council Mode')
    expect(section).not.toContain('## Council Response')
  })

  test('empty seats do not fabricate a council member', () => {
    const section = buildOrchestratorSection({ ...DEFAULT_CONFIG, council: { seats: {} } })
    expect(section).not.toContain('councillor')
  })
})

describe('role prompts', () => {
  const keys: PromptKey[] = ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'councillor']
  for (const key of keys) {
    test(`${key} ends with the task report-format override`, () => {
      expect(rolePrompt(key).endsWith('Se a tarefa definir um formato de relatório, ele substitui o formato acima.')).toBe(true)
    })
  }

  test('Codex roles use rg and shell diagnostics with read-only research', () => {
    for (const key of ['explorer', 'librarian'] as const) {
      expect(rolePrompt(key)).toContain('rg')
      expect(rolePrompt(key)).toContain('READ-ONLY')
      expect(rolePrompt(key)).toContain('shell')
    }
    expect(rolePrompt('explorer')).toContain('<results>')
    expect(rolePrompt('explorer')).not.toContain('ast_grep_search')
    expect(rolePrompt('librarian')).toContain('busca na web e MCPs de documentação disponíveis')
    expect(rolePrompt('librarian')).not.toContain('context7')
    expect(rolePrompt('librarian')).not.toContain('gh_grep')
  })

  test('fixer implements within scope, edits with apply_patch and does not commit', () => {
    const prompt = rolePrompt('fixer')
    for (const text of ['apply_patch', '<summary>', '<changes>', '<verification>', 'orchestrator', 'commit', 'NO spawning subagents', 'No design work']) {
      expect(prompt).toContain(text)
    }
  })

  test('native review and council use read-only tools while designer can edit', () => {
    for (const key of ['oracle', 'councillor'] as const) {
      expect(rolePrompt(key)).toContain('Read/Grep/Glob')
      expect(rolePrompt(key)).toContain('READ-ONLY')
    }
    expect(rolePrompt('designer')).toContain('Read/Grep/Glob/Edit')
    expect(rolePrompt('designer')).toContain('Typography')
    expect(rolePrompt('designer')).toContain('Motion & Interaction')
    expect(rolePrompt('councillor')).toContain('independent')
  })
})
