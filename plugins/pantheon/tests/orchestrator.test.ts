import { describe, expect, test } from 'claude-code/testing'
import { DEFAULTS } from './fixtures/config'
import type { PromptKey } from '../hooks/types'
import { buildOrchestratorSection } from '../hooks/prompts/orchestrator'
import { rolePrompt } from '../hooks/prompts/roles'

describe('orchestrator budget', () => {
  // The git route adds its required brief fields; the limit keeps a small growth margin.
  test('the prompt stays within 5350 chars', () => {
    expect(buildOrchestratorSection(DEFAULTS).length).toBeLessThanOrEqual(5350)
  })
})

describe('orchestrator section', () => {
  test('librarian routing mentions passing and releasing a logged-in terminal-browser', () => {
    expect(buildOrchestratorSection(DEFAULTS)).toContain('terminal-browser action --browser <key> done')
  })

  test('routes every role and seat through Agent', () => {
    const section = buildOrchestratorSection(DEFAULTS)
    for (const role of ['explorer', 'librarian', 'executor', 'oracle', 'designer', 'git']) {
      expect(section).toContain(`Agent({ subagent_type: "pantheon:${role}"`)
      expect(section).toContain(`@${role}`)
    }
    expect(section).toContain('Council seats: Agent pantheon:councillor-alpha, Agent pantheon:councillor-beta')
    for (const text of ['delegate(', 'delegate_result', 'delegate_cancel', 'resume: <jobId>', 'jobId', 'apply_patch', 'Codex', 'codex']) {
      expect(section).not.toContain(text)
    }
    for (const text of ['run_in_background: true', 'Completion notifications', 'Stop an agent']) {
      expect(section).toContain(text)
    }
  })

  for (const role of ['explorer', 'librarian', 'executor', 'oracle', 'designer', 'git']) {
    test(`disabled ${role} disappears from routing, examples and skill mappings`, () => {
      const section = buildOrchestratorSection({ ...DEFAULTS, disabledAgents: [role] })
      expect(section).not.toContain(`@${role}`)
      expect(section).not.toContain(`pantheon:${role}`)
    })
  }

  test('same config produces the same bytes without mutating it', () => {
    const before = JSON.stringify(DEFAULTS)
    expect(buildOrchestratorSection(DEFAULTS)).toBe(buildOrchestratorSection(DEFAULTS))
    expect(JSON.stringify(DEFAULTS)).toBe(before)
  })

  test('removes unsupported vocabulary and obsolete source sections', () => {
    const section = buildOrchestratorSection(DEFAULTS)
    for (const text of ['task_revive', 'task_message', 'task_status', 'wait_for_user', '`question`', 'marketplace', 'Marketplace', 'Todo Continuity', '<Communication>', 'Permissions:', 'Stats:', '@observer']) {
      expect(section).not.toContain(text)
    }
  })

  test('keeps workflow, background discipline, amendments, handoff and reuse', () => {
    const section = buildOrchestratorSection(DEFAULTS)
    for (const heading of ['## 1. Understand', '## 2. Path Selection', '## 3. Delegation Check', '## 4. Plan and Parallelize', '## 5. Verify', 'Background Task Discipline', 'Active Task Amendments', 'Design Handoff Discipline', 'Session Reuse']) {
      expect(section).toContain(heading)
    }
    for (const text of ['run_in_background: true', 'end the turn', 'partial changes', 'Read/Grep/Glob/Edit']) {
      expect(section).toContain(text)
    }
  })

  test('without the designer the handoff section is gone', () => {
    expect(buildOrchestratorSection({ ...DEFAULTS, disabledAgents: ['designer'] })).not.toContain('Design Handoff Discipline')
  })

  test('ordinary section mentions seats in one line without injecting Council Mode', () => {
    const section = buildOrchestratorSection(DEFAULTS)
    expect(section).toContain('pantheon:councillor-alpha')
    expect(section).toContain('pantheon:councillor-beta')
    expect(section.split('\n').filter(line => line.includes('councillor')).length).toBe(1)
    expect(section).not.toContain('## Council Mode')
    expect(section).not.toContain('## Council Response')
  })

  test('empty seats do not fabricate a council member', () => {
    expect(buildOrchestratorSection({ ...DEFAULTS, council: { seats: {} } })).not.toContain('councillor')
  })
})

describe('role prompts', () => {
  const keys: PromptKey[] = ['explorer', 'librarian', 'executor', 'oracle', 'designer', 'git', 'councillor']

  test('git routing keeps decisions and validation with the orchestrator and covers repository state', () => {
    const section = buildOrchestratorSection(DEFAULTS)
    expect(section).toContain('Delegate: commit, squash, push and PR/MR after validation')
    for (const text of ['checkout', 'switch', 'worktree', 'stash']) expect(section).toContain(text)
    expect(section).toContain('what to include, branch, base, squash yes/no, push yes/no, PR/MR yes/no')
    expect(section).toContain('The orchestrator decides and validates; @git performs the git work')
    expect(section).not.toContain('orchestrator commits')
  })

  test('designer leaves commit and push to git', () => {
    expect(rolePrompt('designer')).toContain('Do not commit or push; the git role handles your delivered changes.')
  })

  test('executor leaves commit and push to git', () => {
    const prompt = rolePrompt('executor')
    expect(prompt).toContain('Do not commit or push')
    expect(prompt).toContain('the git role')
    expect(prompt).not.toContain('orchestrator commits')
  })

  test('git enforces scope, refusals, conventions and reporting', () => {
    const prompt = rolePrompt('git')
    for (const text of [
      "orchestrator's brief decides", 'what to include, branch, base, squash yes/no, push yes/no, PR/MR yes/no',
      'checkout, switch, worktree and stash',
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

  for (const key of keys) {
    test(`${key} ends with the task report-format override`, () => {
      expect(rolePrompt(key).endsWith('If the task defines a report format, it replaces the format above.')).toBe(true)
    })
  }

  test('executor implements within scope with Edit/Write and does not commit', () => {
    const prompt = rolePrompt('executor')
    for (const text of ['Read/Grep/Glob/Edit/Write', '<summary>', '<changes>', '<verification>', 'orchestrator', 'commit', 'Do not spawn subagents', 'No design work', 'run scripts, test batteries and API calls', 'short result: a table, status or errors, not raw logs']) {
      expect(prompt).toContain(text)
    }
  })

  test('explorer and librarian research read-only with the native tools', () => {
    for (const key of ['explorer', 'librarian'] as const) {
      expect(rolePrompt(key)).toContain('Read/Grep/Glob')
      expect(rolePrompt(key)).toContain('without changing files or state')
    }
    expect(rolePrompt('explorer')).toContain('<results>')
    expect(rolePrompt('librarian')).toContain('WebSearch, WebFetch and the documentation MCPs available to you')
  })

  test('review and council use read-only tools while designer can edit', () => {
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
