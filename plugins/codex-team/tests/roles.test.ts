import { expect, test } from 'claude-code/testing'
import { agentName, codexArgs, SLUG, SPECS } from '../hooks/roles'

test('every role and model starts with the priority service tier including luna, sol and astra', () => {
  for (const spec of Object.values(SPECS)) {
    for (const model of ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-ASTRA', 'another-model']) {
      const args = codexArgs({ ...spec, model }, spec.effort, [])
      expect(args).toContain(model)
      expect(args).toContain('service_tier="priority"')
      expect(args.filter(arg => arg.startsWith('service_tier='))).toHaveLength(1)
    }
  }
})

test('astra caps xhigh at high with priority and other models retain their effort', () => {
  for (const base of Object.values(SPECS)) {
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol-astra', 'gpt-6-ASTRA']) {
      const spec = { ...base, model, effort: 'xhigh' as const }
      const args = codexArgs(spec, 'xhigh', [])
      expect(args).toContain('model_reasoning_effort="high"')
      expect(args).not.toContain('model_reasoning_effort="xhigh"')
      expect(args).toContain('service_tier="priority"')
      for (const effort of ['low', 'medium', 'high'] as const) expect(codexArgs(spec, effort, [])).toContain(`model_reasoning_effort="${effort}"`)
    }
    expect(codexArgs(base, 'xhigh', [])).toContain('model_reasoning_effort="xhigh"')
  }
})

test('task slugs stop at 22 characters without truncation and reviewers use the architect name', () => {
  expect(SLUG.test('s'.repeat(22))).toBe(true)
  expect(SLUG.test('s'.repeat(23))).toBe(false)
  expect(agentName('reviewer', 's'.repeat(22))).toHaveLength(32)
  expect(agentName('reviewer', 'fix')).toBe('architect-fix')
})
