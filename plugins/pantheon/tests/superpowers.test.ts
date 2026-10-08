import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG } from '../hooks/defaults'
import { buildOrchestratorSection } from '../hooks/prompts/orchestrator'
import { buildSuperpowersBlock } from '../hooks/prompts/superpowers'

test('maps implementer and UI work and keeps one task reviewer per gate', () => {
  const block = buildSuperpowersBlock(DEFAULT_CONFIG)
  expect(block).toContain('delegate({ agent: "fixer"')
  expect(block).toContain('pantheon:designer')
  expect(block).toContain('one dispatch per gate')
  expect(block).toContain('pantheon:oracle')
  expect(block).toContain('separate dispatch')
  expect(block).toContain('dispatching-parallel-agents')
  expect(buildOrchestratorSection(DEFAULT_CONFIG)).toContain(block)
})

test('executing-plans remains an explicit inline exception', () => {
  const block = buildSuperpowersBlock(DEFAULT_CONFIG)
  expect(block).toContain('executing-plans')
  expect(block).toContain('exception')
  expect(block).toContain('main agent')
  expect(block).toContain('do not convert')
})

test('preserves skill process, model, report format and oracle review package', () => {
  const block = buildSuperpowersBlock(DEFAULT_CONFIG)
  for (const text of ['steps', 'gates', 'model', 'report format', 'review-package', 'diff', 'BASE', 'HEAD', 'Bash']) {
    expect(block).toContain(text)
  }
})

test('implementer dispatch assigns commits to orchestrator before generating review package', () => {
  const block = buildSuperpowersBlock(DEFAULT_CONFIG)
  for (const text of ['orchestrator commits', '.git', 'read-only', 'SHA', 'before dispatch', 'no commit is expected', 'BLOCKED', 'resume', 'jobId', 'fallback', 'brief', 'findings']) {
    expect(block).toContain(text)
  }
})

for (const role of ['fixer', 'designer', 'oracle']) {
  test(`disabled ${role} mapping disappears with standard Agent fallback`, () => {
    const block = buildSuperpowersBlock({ ...DEFAULT_CONFIG, disabledAgents: [role] })
    expect(block).not.toContain(`pantheon:${role}`)
    expect(block).not.toContain(`agent: "${role}"`)
    expect(block).toContain('standard Agent tool')
  })
}
