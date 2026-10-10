import { describe, expect, test } from 'claude-code/testing'
import { DEFAULTS } from './fixtures/config'
import type { PromptKey } from '../hooks/types'
import { buildLeadSection } from '../hooks/prompts/lead'
import { rolePrompt } from '../hooks/prompts/roles'

describe('lead budget', () => {
  // Checked: the default config, and each role or configured seat disabled one at a time.
  // The council has two seats (alpha, beta); config.ts rejects any other seat name, so no seat can sit outside this ceiling.
  const LEAD_BUDGET = 4300
  test('the default prompt stays within 4300 chars', () => {
    expect(buildLeadSection(DEFAULTS).length).toBeLessThanOrEqual(LEAD_BUDGET)
  })
  for (const role of ['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux', 'council']) {
    test(`the prompt with ${role} disabled stays within 4300 chars`, () => {
      expect(buildLeadSection({ ...DEFAULTS, disabledAgents: [role] }).length).toBeLessThanOrEqual(LEAD_BUDGET)
    })
  }
})

describe('lead section', () => {
  test('docs-reader routing mentions passing and releasing a logged-in terminal-browser', () => {
    expect(buildLeadSection(DEFAULTS)).toContain('terminal-browser action --browser <key> done')
  })

  test('routes every role and seat through Agent', () => {
    const section = buildLeadSection(DEFAULTS)
    for (const role of ['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux']) {
      expect(section).toContain(`Agent({ subagent_type: "pantheon:${role}"`)
      expect(section).toContain(`@${role}`)
    }
    expect(section).toContain('Council seats: Agent pantheon:councillor-alpha, Agent pantheon:councillor-beta')
    expect(section).toContain('never implement it yourself')
    expect(section).toContain('low-risk')
    expect(section).toContain('else pass its brief and result to a new Agent')
    for (const text of ['delegate(', 'delegate_result', 'delegate_cancel', 'resume: <jobId>', 'jobId', 'apply_patch', 'Codex', 'codex']) {
      expect(section).not.toContain(text)
    }
    for (const text of ['run_in_background: true', 'Completion notifications', 'Stop an agent']) {
      expect(section).toContain(text)
    }
  })

  for (const role of ['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux']) {
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
    const ux = section.slice(section.indexOf('@ux\n'), section.length)
    const developer = section.slice(section.indexOf('@developer\n'), section.indexOf('@architect\n'))
    for (const text of ['layout, hierarchy, color, spacing, motion', 'UI copy', 'implement, not advise']) expect(ux).toContain(text)
    for (const text of ['non-trivial or multi-file code', 'UI code and logic', 'commits its own task']) expect(developer).toContain(text)
    expect(section).toContain('Route visual and UX work to @ux')
    expect(section).toContain('@developer may do bounded mechanical follow-up that preserves the design exactly; visual judgment or changed feel returns to @ux')
  })

  test('acceptance criteria verification routes to qa', () => {
    const section = buildLeadSection(DEFAULTS)
    const qa = section.slice(section.indexOf('@qa\n'), section.indexOf('@ux\n'))
    expect(qa).toContain('acceptance criteria verification')
    expect(qa).toContain('never fixes')
    expect(buildLeadSection({ ...DEFAULTS, disabledAgents: ['qa'] })).not.toContain('acceptance criteria verification')
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
  const keys: PromptKey[] = ['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux', 'councillor']

  test('git rule: the lead commits, pushes and opens PRs itself, with push refusals and no git agent', () => {
    const section = buildLeadSection(DEFAULTS)
    expect(section).not.toContain('@git')
    expect(section).not.toContain('pantheon:git')
    expect(section).toContain('You commit your own work, push, squash and open PRs/MRs yourself')
    expect(section).toContain('developer and ux commit their own task; only you push')
    expect(section).toContain('never merge a PR/MR unless the person asks')
    expect(section).toContain('no force push without `--force-with-lease`, no remote branch deletion, no `--mirror`, never main, master, develop, release or release/*')
  })

  test('developer and ux commit their own task and never push', () => {
    for (const key of ['developer', 'ux'] as const) {
      const prompt = rolePrompt(key)
      for (const text of [
        'git add -- <paths>', 'git commit -m "<type>(<scope>): <summary> [<phase>]" -- <paths>',
        'Never `git add -A`, `git add .`, `--no-verify` or `--amend`', 'no globs in pathspecs', '`git mv` or `git rm`', '(no `-F`, no editor or `-e`)', 'No AI attribution', 'retry once',
        'report it to the lead instead of bypassing it', 'Never push, rebase, reset, merge, switch branches, stash or rewrite history: the lead pushes',
      ]) expect(prompt).toContain(text)
      expect(prompt).not.toContain('Do not commit or push')
    }
  })

  test('qa runs what was built, never fixes, never runs side effects and returns a structured verdict', () => {
    const prompt = rolePrompt('qa')
    for (const text of [
      'Verify, never fix', 'Never fix code', 'Never run side effects', 'deploy, publish, push', 'migration against shared data',
      'Write only inside the session scratchpad', 'herdr pane', 'error paths', 'Partial coverage is a failure',
      'C<n>: pass|fail — <evidence', 'QA: pass|fail',
    ]) expect(prompt).toContain(text)
    expect(prompt).not.toContain('Do not commit or push')
  })

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
