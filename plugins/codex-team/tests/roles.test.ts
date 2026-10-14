import { expect, test } from 'claude-code/testing'
import { agentName, codexArgs, SLUG, SPECS } from '../hooks/roles'

test('every role and model starts with the priority service tier including luna, sol and astra', () => {
  for (const spec of Object.values(SPECS)) {
    for (const model of ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-ASTRA', 'another-model']) {
      const args = codexArgs(spec, { model, effort: spec.effort }, [])
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
      const args = codexArgs(spec, { model, effort: 'xhigh' }, [])
      expect(args).toContain('model_reasoning_effort="high"')
      expect(args).not.toContain('model_reasoning_effort="xhigh"')
      expect(args).toContain('service_tier="priority"')
      for (const effort of ['low', 'medium', 'high'] as const) expect(codexArgs(spec, { model, effort }, [])).toContain(`model_reasoning_effort="${effort}"`)
    }
    expect(codexArgs(base, { model: base.model, effort: 'xhigh' }, [])).toContain('model_reasoning_effort="xhigh"')
  }
})

test('task slugs stop at 22 characters without truncation and reviewers use the architect name', () => {
  expect(SLUG.test('s'.repeat(22))).toBe(true)
  expect(SLUG.test('s'.repeat(23))).toBe(false)
  expect(agentName('reviewer', 's'.repeat(22))).toHaveLength(32)
  expect(agentName('reviewer', 'fix')).toBe('architect-fix')
})

test('profile pairs change only model and effort flags while the role keeps instructions sandbox and roots', () => {
  for (const spec of Object.values(SPECS)) {
    const baseline = codexArgs(spec, spec, ['/reports']).filter((_, i) => i !== 1 && i !== 3)
    for (const model of ['gpt-6.1-sol', 'gpt-6-luna']) for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      const args = codexArgs(spec, { model, effort }, ['/reports'])
      expect(args[1]).toBe(model)
      expect(args[3]).toBe(`model_reasoning_effort="${effort}"`)
      expect(args.filter((_, i) => i !== 1 && i !== 3)).toEqual(baseline)
    }
  }
})

test('reviewer role default is Sol high and keeps report-only instructions', () => {
  expect(SPECS.reviewer.model).toBe('gpt-6.1-sol')
  expect(SPECS.reviewer.effort).toBe('high')
  expect(SPECS.reviewer.writes).toBe(false)
  expect(SPECS.reviewer.instructions).toContain('Write only the named reviewer report; leave the repository untouched.')
})
