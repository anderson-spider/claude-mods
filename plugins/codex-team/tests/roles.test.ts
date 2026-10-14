import { expect, test } from 'claude-code/testing'
import { agentName, codexArgs, SLUG, SPECS, startEffort } from '../hooks/roles'

test('Fast adds the priority service tier for every role and model including luna, sol and astra, and is off by default', () => {
  for (const spec of Object.values(SPECS)) {
    for (const model of ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-ASTRA', 'another-model']) {
      const fast = codexArgs(spec, { model, effort: spec.effort }, [], true)
      expect(fast).toContain(model)
      expect(fast.filter(arg => arg.startsWith('service_tier='))).toEqual(['service_tier="priority"'])
      for (const off of [codexArgs(spec, { model, effort: spec.effort }, [], false), codexArgs(spec, { model, effort: spec.effort }, [])]) {
        expect(off.filter(arg => arg.startsWith('service_tier='))).toEqual([])
        expect(fast.filter(arg => !off.includes(arg))).toEqual(['service_tier="priority"'])
      }
    }
  }
})

test('astra caps xhigh at high and other models retain their effort', () => {
  for (const base of Object.values(SPECS)) {
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol-astra', 'gpt-6-ASTRA']) {
      const spec = { ...base, model, effort: 'xhigh' as const }
      const args = codexArgs(spec, { model, effort: 'xhigh' }, [])
      expect(args).toContain('model_reasoning_effort="high"')
      expect(args).not.toContain('model_reasoning_effort="xhigh"')
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
    for (const model of ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']) for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      const args = codexArgs(spec, { model, effort }, ['/reports'])
      expect(args[1]).toBe(model)
      expect(args[3]).toBe(`model_reasoning_effort="${startEffort(model, effort).effort}"`)
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
