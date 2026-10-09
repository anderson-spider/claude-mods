import { describe, expect, test } from 'claude-code/testing'
import { MIXED, CLAUDE, CODEX, resolved } from './fixtures/profiles'
import type { PromptKey } from '../hooks/types'
import { buildOrchestratorSection } from '../hooks/prompts/orchestrator'
import { rolePrompt } from '../hooks/prompts/roles'

describe('orchestrator budget', () => {
  // The git route adds its required brief fields and keeps a small growth margin.
  test('claude prompt stays within 5350 chars', () => {
    expect(buildOrchestratorSection(CLAUDE).length).toBeLessThanOrEqual(5350)
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
    for (const role of ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'git']) {
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
    for (const role of ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'git']) {
      expect(section).toContain(`delegate({ agent: "${role}"`)
      expect(section).not.toContain(`pantheon:${role}`)
    }
    expect(section).toContain('Council seats: delegate councillor:alpha, delegate councillor:beta')
    expect(section).toContain('run_in_background: true')
    expect(section).toContain('delegate_result')
    for (const text of ['delegate_cancel({ jobId })', 'resume: <jobId>', 'not the raw sessionId'])
      expect(section).toContain(text)
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
      ...MIXED, disabledAgents: ['explorer', 'librarian', 'fixer', 'git', 'council'],
    })).not.toContain('delegate_result')
  })

  test('lists active roles with the correct calling tools', () => {
    const section = buildOrchestratorSection(MIXED)
    for (const role of ['explorer', 'librarian', 'fixer', 'git']) {
      expect(section).toContain(`@${role}`)
      expect(section).toContain(`delegate({ agent: "${role}"`)
    }
    expect(section).toContain('Agent({ subagent_type: "pantheon:oracle"')
    expect(section).toContain('Agent({ subagent_type: "pantheon:designer"')
  })

  for (const role of ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'git']) {
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
  const keys: PromptKey[] = ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'git', 'councillor']
  test('git routing keeps decisions and validation with the orchestrator', () => {
    for (const config of [CLAUDE, CODEX, MIXED]) {
      const section = buildOrchestratorSection(config)
      expect(section).toContain('Delegate: commit, squash, push and PR/MR after validation')
      expect(section).toContain('what to include, branch, base, squash yes/no, push yes/no, PR/MR yes/no')
      expect(section).toContain('The orchestrator decides and validates; @git performs the git work')
      expect(section).not.toContain('orchestrator commits')
    }
  })

  for (const engine of ['codex', 'claude'] as const) {
    test(`${engine} designer leaves commit and push to git`, () => {
      expect(rolePrompt('designer', engine)).toContain('Do not commit or push; the git role handles your delivered changes.')
    })

    test(`${engine} fixer leaves commit and push to git`, () => {
      const prompt = rolePrompt('fixer', engine)
      expect(prompt).toContain('Do not commit or push')
      expect(prompt).toContain('the git role')
      expect(prompt).not.toContain('orchestrator commits')
    })

    test(`${engine} git enforces scope, refusals, conventions and reporting`, () => {
      const prompt = rolePrompt('git', engine)
      for (const text of [
        "orchestrator's brief decides", 'what to include, branch, base, squash yes/no, push yes/no, PR/MR yes/no',
        'git status', 'git diff', "Stage only the task's files", 'git log', 'Conventional Commits in English',
        'PR/MR template', 'gh', 'glab', 'Preserve unrelated changes', 'Never add AI attribution',
        'Refuse commit, push, rebase, reset or merge that modifies the default branch, main/master/develop or a protected branch',
        "Discover the relevant remote's default branch", 'git symbolic-ref refs/remotes/<remote>/HEAD',
        'gh repo view / glab repo view', 'confirm the branch you modify or push to is neither default nor protected',
        'both the local branch and remote push destination', 'stop and report: unknown is not unprotected',
        'Using main as a PR/MR base or rebasing the task branch onto main is allowed',
        'the refusal concerns modifying those branches, not using them as a base',
        'Refuse force push without --force-with-lease', 'Refuse merging a PR/MR',
        'Refuse deleting remote branches', 'Rewrite history (squash, amend or rebase of the branch) only within',
        "the range of the task's commits the orchestrator names in the brief, whoever created them",
        'Refuse history outside that range', 'If the range is missing or ambiguous, stop and report',
        'Refuse touching work outside the task', 'hook, conflict, auth', 'stop and report rather than improvise',
        'Do not spawn subagents or delegate', 'sha + subject', 'branch and push result', 'PR/MR URL', 'refused or skipped',
      ]) expect(prompt).toContain(text)
      expect(prompt).not.toContain('Refuse rewriting history you did not create in this task')
    })
  }
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
