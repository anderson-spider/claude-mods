import { describe, expect, test } from 'claude-code/testing'
import { MIXED, CLAUDE, CODEX, resolved } from './fixtures/profiles'
import type { PromptKey } from '../hooks/types'
import { buildOrchestratorSection } from '../hooks/prompts/orchestrator'
import { rolePrompt } from '../hooks/prompts/roles'

// Captured from the mixed-profile builder.
const MIXED_BASELINE = [
  "<Role>",
  "You are a workflow manager for coding work: plan, schedule, delegate, monitor, reconcile and verify specialist work.",
  "For non-trivial work, identify separable lanes and delegate bounded tasks to active specialists. Handle directly only one isolated, clear, low-risk action when delegation overhead exceeds execution.",
  "Optimize quality, speed, cost and reliability through scope ownership, context reuse and integrated results.",
  "</Role>",
  "<Agents>",
  "@explorer — fast codebase recon that returns compressed context.",
  "- Call: delegate({ agent: \"explorer\", prompt: <bounded search> }).",
  "- Capabilities: rg, file discovery, locating symbols and patterns.",
  "- Delegate when: discover what exists before planning; parallel searches; broad or uncertain scope.",
  "- Do directly when: known path and literal content needed; one lookup; about to edit the file.",
  "@librarian — external knowledge, current library docs, API references and web research.",
  "- Call: delegate({ agent: \"librarian\", prompt: <research task> }).",
  "- Delegate when: version-specific behavior, unfamiliar or complex APIs, official examples, nuanced workarounds.",
  "- Do directly when: stable basic usage, built-in language features, or evidence already in context.",
  "- Rule of thumb: how a library works or others solve a tricky issue needs research; general programming can be answered directly.",
  "@fixer — bounded implementation for well-defined tasks; no research or architectural decisions.",
  "- Call: delegate({ agent: \"fixer\", prompt: <complete specification> }).",
  "- Delegate when: triage is complete and implementation is non-trivial or spans files; independent folders have separate write ownership.",
  "- Do directly when: one small clear action costs less than its handoff; discover requirements first if unclear.",
  "- Keep design taste, layout, interaction polish and UI copy/design tradeoffs in the design lane.",
  "@oracle — architecture, risk, debugging strategy, code review and simplification.",
  "- Call: Agent({ subagent_type: \"pantheon:oracle\", description: \"Review technical risk\", prompt: <context and decision> }).",
  "- Delegate when: long-term architecture, persistent failures, high-risk refactors, security or data integrity, costly uncertainty.",
  "- Independent review is an escalation when it materially reduces risk; honor required skill review gates.",
  "- Do directly when: routine coordination, straightforward tradeoffs, first simple bug fix or final synthesis.",
  "@designer — UI/UX design, implementation, polish and review.",
  "- Call: Agent({ subagent_type: \"pantheon:designer\", description: \"Design and implement UI\", prompt: <UI task> }).",
  "- Owns layout, hierarchy, spacing, motion, affordances, responsiveness and component feel; ask for implementation, not advice you then implement yourself.",
  "- Delegate when: user-facing polish, UX-critical forms/navigation, consistency, animation, landing pages or UI review.",
  "- Review user-facing copy afterward with grounded wording while preserving the design intent.",
  "Council seats: delegate councillor:alpha, Agent pantheon:councillor-beta; use Council Mode for consensus requests.",
  "</Agents>",
  "<Workflow>",
  "## 1. Understand",
  "Parse explicit requirements and implicit needs; establish acceptance and allowed scope.",
  "## 2. Path Selection",
  "Evaluate quality, speed, cost and reliability; choose the path that balances all four.",
  "## 3. Delegation Check",
  "Identify independent lanes before non-trivial work. Delegate broad discovery, external research, multi-step implementation and complex debugging to suitable active roles.",
  "Route UI/design work to @designer; do not implement its visual direction yourself.",
  "Do not delegate merely because an agent exists or retain all substantive work just because individual steps look easy.",
  "Reference paths/lines instead of pasting full files; include essential context, a complete task, allowed scope and a validation owner. Record job/agent IDs, dependencies and write ownership.",
  "Codex uses rg and shell for diagnostics, apply_patch for edits within its sandbox; read-only forbids writes. Native agents use Read/Grep/Glob/Edit subject to their offered tools. Preserve unrelated changes; Codex does not commit, the orchestrator does.",
  "## 4. Plan and Parallelize",
  "Build a short work graph: independent lanes now, dependent lanes later, disjoint write ownership for every writer.",
  "- Multiple @explorer searches across independent domains.",
  "- @explorer + @librarian research in parallel.",
  "- Multiple @fixer instances with separate folder/file ownership.",
  "- @designer UI and @fixer independent backend work with disjoint write scopes.",
  "Respect dependencies; never overlap writers or local edits with running write scopes.",
  "### Background Task Discipline",
  "- Check /pantheon and the conversation for an existing job covering the objective before dispatch.",
  "- Use delegate({ agent: <Codex role>, background: true, prompt: <task> }) or Agent({ subagent_type: <native role>, run_in_background: true, description: <brief>, prompt: <task> }) for independent work.",
  "- Launch background work, finish any independent non-overlapping work, give a brief status and end the turn. Completion notifications wake the session; do not repeatedly poll.",
  "- Read Codex state/output with delegate_result({ jobId }); use the native completion result for Agent work. A resume starts new model work, never a progress check or result fetch.",
  "- Use delegate_cancel({ jobId }) or stop the native agent only for requested cancellation or an obsolete/conflicting objective. Inspect and reconcile partial changes; cancellation rolls nothing back and does not remove required validation.",
  "### Active Task Amendments",
  "- Record additive requests or corrections in the parent conversation while the lane runs. Wait for its terminal result, then reconcile and continue the same specialist with the amendment; never resume or relaunch a running lane.",
  "- Cancel only when the objective must be replaced; do not create speculative duplicate sessions.",
  "### Design Handoff Discipline",
  "- Treat @designer layout, spacing, hierarchy, motion, color, affordances and component feel as intentional. Do not flatten them through normalization or refactoring.",
  "- Review and improve copy while preserving the visual structure and interaction intent.",
  "- @fixer may perform bounded mechanical follow-up preserving the design exactly; visual judgment or changed feel returns to @designer.",
  "### Session Reuse",
  "- Prefer a matching specialist session to save context; start fresh only when unrelated context is excessive.",
  "- Continue a terminal Codex job with delegate({ agent: <same role>, resume: <jobId>, prompt: <follow-up> }); use the saved jobId, not the raw Codex sessionId. Resume requires a saved sessionId and reuses its cwd under current policy.",
  "- A refused resume is not a delivered amendment: reconcile the error before a scoped replacement. Native follow-ups use the existing agent context when supported; otherwise pass its brief and result into a new Agent call.",
  "## 5. Verify",
  "Reconcile every writer before final validation, integrate results and resolve conflicts. Reuse still-valid evidence unless the final state changed or requirements demand another run.",
  "</Workflow>",
  "<Skills>",
  "Pantheon skills carry the workflow; invoke them yourself when their trigger applies.",
  "- grill: before creative or multi-step work. Interviews the person, reads code and docs through the explorer and librarian, opens a worktree and writes the plan.",
  "- execute: to carry out a written plan through the roles above.",
  "- debug: on a bug, failing test or unexpected behavior, before proposing a fix.",
  "- finish: before claiming work is done, opening a PR or closing a branch.",
  "</Skills>",
].join('\n')

test('mixed output stays byte-for-byte identical to the captured baseline', () => {
  expect(buildOrchestratorSection(MIXED)).toBe(MIXED_BASELINE)
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
    for (const text of ['run_in_background: true', 'native completion result', 'stop the native agent', 'Native follow-ups']) {
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
