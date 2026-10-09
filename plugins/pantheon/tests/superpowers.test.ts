import { expect, test } from 'claude-code/testing'
import { MIXED, CLAUDE, CODEX, resolved } from './fixtures/profiles'
import { buildOrchestratorSection } from '../hooks/prompts/orchestrator'
import { buildSuperpowersBlock } from '../hooks/prompts/superpowers'

// Captured from the unchanged mixed-profile builder before engine routing changes.
const MIXED_BASELINE = [
  "## Superpowers Integration",
  "Only when a skill requires dispatch: use these role mappings while preserving its steps, gates, model choice, prompt and report format. This block does not itself trigger a skill or dispatch.",
  "- implementer (subagent-driven-development): delegate({ agent: \"fixer\", model: <skill-selected model>, prompt: <skill brief> }).",
  "- UI implementer: Agent({ subagent_type: \"pantheon:designer\", model: <skill-selected model>, prompt: <skill brief>, description: \"Implement UI task\" }).",
  "- Task reviewer and re-reviewer (subagent-driven-development): Agent with pantheon:oracle; one dispatch per gate, including the scripts/review-package file.",
  "- Final branch code reviewer (subagent-driven-development, requesting-code-review): Agent with pantheon:oracle, a separate dispatch from the task review.",
  "- dispatching-parallel-agents: several delegate/Agent calls in the same message, selecting an active role for each task.",
  "- A disabled role has no mapping; use the standard Agent tool for that skill dispatch.",
  "- executing-plans is an explicit exception to general delegation: execute inline in the main agent; do not convert its implementation steps into dispatches.",
  "- Pass the skill-selected model through model on delegate or Agent. A skill-defined report format overrides the role default.",
  "- Reviewers receive a review package file: scripts/review-package for SDD, or an orchestrator-generated file with diff and BASE/HEAD SHAs for requesting-code-review. The native reviewer has no Bash.",
  "- Keep one Codex implementer session per task: continue a terminal job with resume: <jobId>. If reuse is unavailable, follow the skill fallback with a new implementer given the brief, report and findings.",
  "- Codex .git is read-only: the implementer changes code, tests and reports; the orchestrator commits, records the SHA, then generates the review package. Record BASE before dispatch; HEAD is that commit.",
  "- Tell the implementer in its dispatch prompt: no commit is expected; absence of a commit is not a reason to report BLOCKED.",
].join('\n')

test('mixed output stays byte-for-byte identical to the captured baseline', () => {
  expect(buildSuperpowersBlock(MIXED)).toBe(MIXED_BASELINE)
})

test('maps implementer and UI work and keeps one task reviewer per gate', () => {
  const block = buildSuperpowersBlock(MIXED)
  expect(block).toContain('delegate({ agent: "fixer"')
  expect(block).toContain('pantheon:designer')
  expect(block).toContain('one dispatch per gate')
  expect(block).toContain('pantheon:oracle')
  expect(block).toContain('separate dispatch')
  expect(block).toContain('dispatching-parallel-agents')
  expect(buildOrchestratorSection(MIXED)).toContain(block)
})

test('claude maps native implementers and reviewers without Codex restrictions', () => {
  const block = buildSuperpowersBlock(CLAUDE)
  expect(block).toContain('Agent({ subagent_type: "pantheon:fixer"')
  expect(block).toContain('Agent({ subagent_type: "pantheon:designer"')
  expect(block).toContain('The implementer does not commit; the orchestrator commits, records the SHA, then generates the review package.')
  expect(block).toContain('The native reviewer has no Bash.')
  expect(block).not.toContain('resume: <jobId>')
  expect(block).not.toContain('.git is read-only')
})

test('codex maps implementers and both review gates with shell-readable packages', () => {
  const block = buildSuperpowersBlock(CODEX)
  expect(block).toContain('delegate({ agent: "fixer"')
  expect(block).toContain('delegate({ agent: "designer"')
  const reviewers = block.split('\n').filter(line => line.includes('reviewer ('))
  expect(reviewers.length).toBe(2)
  for (const line of reviewers) expect(line).toContain('delegate({ agent: "oracle"')
  expect(block).toContain('review package path through the prompt')
  expect(block).toContain('shell')
  expect(block).toContain('.git is read-only')
  expect(block).not.toContain('The native reviewer has no Bash.')
})

test('per-role overrides choose mappings independently of the profile name', async () => {
  const config = await resolved('mixed', { profiles: { mixed: { agents: {
    fixer: { engine: 'claude' }, designer: { engine: 'codex' }, oracle: { engine: 'codex' },
  } } } })
  const block = buildSuperpowersBlock(config)
  expect(block).toContain('Agent({ subagent_type: "pantheon:fixer"')
  expect(block).toContain('delegate({ agent: "designer"')
  expect(block).toContain('delegate({ agent: "oracle"')
  expect(block).not.toContain('resume: <jobId>')
  expect(block).not.toContain('.git is read-only')
  expect(block).not.toContain('The native reviewer has no Bash.')
})

test('executing-plans remains an explicit inline exception', () => {
  const block = buildSuperpowersBlock(MIXED)
  expect(block).toContain('executing-plans')
  expect(block).toContain('exception')
  expect(block).toContain('main agent')
  expect(block).toContain('do not convert')
})

test('preserves skill process, model, report format and oracle review package', () => {
  const block = buildSuperpowersBlock(MIXED)
  for (const text of ['steps', 'gates', 'model', 'report format', 'review-package', 'diff', 'BASE', 'HEAD', 'Bash']) {
    expect(block).toContain(text)
  }
})

test('implementer dispatch assigns commits to orchestrator before generating review package', () => {
  const block = buildSuperpowersBlock(MIXED)
  for (const text of ['orchestrator commits', '.git', 'read-only', 'SHA', 'before dispatch', 'no commit is expected', 'BLOCKED', 'resume', 'jobId', 'fallback', 'brief', 'findings']) {
    expect(block).toContain(text)
  }
})

for (const role of ['fixer', 'designer', 'oracle']) {
  test(`disabled ${role} mapping disappears with standard Agent fallback`, () => {
    const block = buildSuperpowersBlock({ ...MIXED, disabledAgents: [role] })
    expect(block).not.toContain(`pantheon:${role}`)
    expect(block).not.toContain(`agent: "${role}"`)
    expect(block).toContain('standard Agent tool')
  })
}
