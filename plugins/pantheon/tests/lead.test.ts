import { describe, expect, test } from 'claude-code/testing'
import { DEFAULTS } from './fixtures/config'
import type { PromptKey } from '../hooks/types'
import { buildLeadSection } from '../hooks/prompts/lead'
import { rolePrompt } from '../hooks/prompts/roles'

describe('lead budget', () => {
  // The git route adds its required brief fields; the limit keeps a small growth margin.
  test('the prompt stays within 5350 chars', () => {
    expect(buildLeadSection(DEFAULTS).length).toBeLessThanOrEqual(5350)
  })
})

describe('lead section', () => {
  test('docs-reader routing mentions passing and releasing a logged-in terminal-browser', () => {
    expect(buildLeadSection(DEFAULTS)).toContain('terminal-browser action --browser <key> done')
  })

  test('routes every role and seat through Agent', () => {
    const section = buildLeadSection(DEFAULTS)
    for (const role of ['code-reader', 'docs-reader', 'developer', 'architect', 'ux', 'git']) {
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

  for (const role of ['code-reader', 'docs-reader', 'developer', 'architect', 'ux', 'git']) {
    test(`disabled ${role} disappears from routing, examples and skill mappings`, () => {
      const section = buildLeadSection({ ...DEFAULTS, disabledAgents: [role] })
      expect(section).not.toContain(`@${role}`)
      expect(section).not.toContain(`pantheon:${role}`)
    })
  }

  test('same config produces the same bytes without mutating it', () => {
    const before = JSON.stringify(DEFAULTS)
    expect(buildLeadSection(DEFAULTS)).toBe(buildLeadSection(DEFAULTS))
    expect(JSON.stringify(DEFAULTS)).toBe(before)
  })

  test('removes unsupported vocabulary and obsolete source sections', () => {
    const section = buildLeadSection(DEFAULTS)
    for (const text of ['task_revive', 'task_message', 'task_status', 'wait_for_user', '`question`', 'marketplace', 'Marketplace', 'Todo Continuity', '<Communication>', 'Permissions:', 'Stats:', '@observer']) {
      expect(section).not.toContain(text)
    }
  })

  test('keeps workflow, background discipline, amendments, handoff and reuse', () => {
    const section = buildLeadSection(DEFAULTS)
    for (const heading of ['## 1. Understand', '## 2. Path Selection', '## 3. Delegation Check', '## 4. Plan and Parallelize', '## 5. Verify', 'Background Task Discipline', 'Active Task Amendments', 'Design Handoff Discipline', 'Session Reuse']) {
      expect(section).toContain(heading)
    }
    for (const text of ['run_in_background: true', 'end the turn', 'partial changes', 'Read/Grep/Glob/Edit']) {
      expect(section).toContain(text)
    }
  })

  test('code routes to developer and visual work to ux', () => {
    const section = buildLeadSection(DEFAULTS)
    const ux = section.slice(section.indexOf('@ux\n'), section.indexOf('@git\n'))
    const developer = section.slice(section.indexOf('@developer\n'), section.indexOf('@architect\n'))
    for (const text of ['layout, hierarchy, color, spacing, motion', 'UI copy', 'implement, not advise']) expect(ux).toContain(text)
    for (const text of ['non-trivial or multi-file code', 'UI code and logic', 'commits its own task']) expect(developer).toContain(text)
    expect(section).toContain('Route visual and UX work to @ux')
    expect(section).toContain('@developer may do bounded mechanical follow-up that preserves the design exactly; visual judgment or changed feel returns to @ux')
  })

  test('without the ux the handoff section is gone', () => {
    expect(buildLeadSection({ ...DEFAULTS, disabledAgents: ['ux'] })).not.toContain('Design Handoff Discipline')
  })

  test('ordinary section mentions seats in one line without injecting Council Mode', () => {
    const section = buildLeadSection(DEFAULTS)
    expect(section).toContain('pantheon:councillor-alpha')
    expect(section).toContain('pantheon:councillor-beta')
    expect(section.split('\n').filter(line => line.includes('councillor')).length).toBe(1)
    expect(section).not.toContain('## Council Mode')
    expect(section).not.toContain('## Council Response')
  })

  test('empty seats do not fabricate a council member', () => {
    expect(buildLeadSection({ ...DEFAULTS, council: { seats: {} } })).not.toContain('councillor')
  })
})

describe('role prompts', () => {
  const keys: PromptKey[] = ['code-reader', 'docs-reader', 'developer', 'architect', 'ux', 'git', 'councillor']

  test('git routing keeps decisions and validation with the lead and covers repository state', () => {
    const section = buildLeadSection(DEFAULTS)
    expect(section).toContain('Delegate: squash and PR/MR after validation')
    for (const text of ['checkout', 'switch', 'worktree', 'stash']) expect(section).toContain(text)
    expect(section).toContain('what to include, branch, base, squash yes/no, PR/MR yes/no')
    expect(section).not.toContain('push yes/no')
    expect(section).toContain('You run only read-only git and push; everything else that changes the repository')
    expect(section).toContain('no force push without `--force-with-lease`, no remote branch deletion, no `--mirror`, never main/master/develop')
    expect(section).not.toContain('lead commits')
  })

  test('developer and ux commit their own task and never push', () => {
    for (const key of ['developer', 'ux'] as const) {
      const prompt = rolePrompt(key)
      for (const text of [
        'git add -- <paths>', 'git commit -m "<type>(<scope>): <summary> [<taskId>]" -- <paths>',
        'Never `git add -A`, `git add .`, `--no-verify` or `--amend`', 'no globs in pathspecs', '`git mv` or `git rm`', '(no `-F`, no editor or `-e`)', 'No AI attribution', 'retry once',
        'report it to the lead instead of bypassing it', 'Never push, rebase, reset, merge, switch branches or stash',
      ]) expect(prompt).toContain(text)
      expect(prompt).not.toContain('Do not commit or push')
    }
  })

  test('git enforces scope, refusals, conventions and reporting', () => {
    const prompt = rolePrompt('git')
    for (const text of [
      "lead's brief decides", 'what to include, branch, base, squash yes/no, PR/MR yes/no', 'Developers commit their own tasks and the lead pushes',
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
      "the range of the task's commits the lead names in the brief, whoever created them",
      'Refuse history outside that range', 'If the range is missing or ambiguous, stop and report',
      'Refuse touching work outside the task', 'hook, conflict, auth', 'stop and report rather than improvise',
      'Do not spawn subagents or delegate', 'sha + subject', 'whether it is on the remote', 'PR/MR URL', 'refused or skipped',
    ]) expect(prompt).toContain(text)
    expect(prompt).not.toContain('Refuse rewriting history you did not create in this task')
  })

  for (const key of keys) {
    test(`${key} ends with the task report-format override`, () => {
      expect(rolePrompt(key).endsWith('If the task defines a report format, it replaces the format above.')).toBe(true)
    })
  }

  test('developer implements within scope with Edit/Write and commits its own files', () => {
    const prompt = rolePrompt('developer')
    for (const text of ['Read/Grep/Glob/Edit/Write', '<summary>', '<changes>', '<verification>', 'lead', 'commit', 'Do not spawn subagents', 'tell the lead it belongs to ux', 'run scripts, test batteries and API calls', 'short result: a table, status or errors, not raw logs']) {
      expect(prompt).toContain(text)
    }
  })

  test('code-reader and docs-reader research read-only with the native tools', () => {
    for (const key of ['code-reader', 'docs-reader'] as const) {
      expect(rolePrompt(key)).toContain('Read/Grep/Glob')
      expect(rolePrompt(key)).toContain('without changing files or state')
    }
    expect(rolePrompt('code-reader')).toContain('<results>')
    expect(rolePrompt('docs-reader')).toContain('WebSearch, WebFetch and the documentation MCPs available to you')
  })

  test('review and council use read-only tools while ux can edit', () => {
    for (const key of ['architect', 'councillor'] as const) {
      expect(rolePrompt(key)).toContain('Read/Grep/Glob')
      expect(rolePrompt(key)).toContain('READ-ONLY')
    }
    expect(rolePrompt('ux')).toContain('Read/Grep/Glob/Edit')
    expect(rolePrompt('ux')).toContain('Typography')
    expect(rolePrompt('ux')).toContain('Motion & Interaction')
    expect(rolePrompt('councillor')).toContain('independent')
  })
})
