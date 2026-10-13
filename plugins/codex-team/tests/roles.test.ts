import { expect, test } from 'claude-code/testing'
import { codexArgs, FAST_MODELS, SPECS } from '../hooks/roles'

test('every fast-capable role starts with the priority service tier', () => {
  expect(FAST_MODELS).toEqual(['gpt-6-luna', 'gpt-6.1-sol'])
  for (const spec of Object.values(SPECS)) {
    const args = codexArgs(spec, spec.effort, [])
    expect(args).toContain('service_tier="priority"')
    expect(args.filter(arg => arg.startsWith('service_tier='))).toHaveLength(1)
  }
})

test('no role on an astra model receives a service tier', () => {
  for (const spec of Object.values(SPECS)) {
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol-astra', 'astra-gpt-6-luna', 'gpt-6-ASTRA']) {
      const args = codexArgs({ ...spec, model }, spec.effort, [])
      expect(args).toContain(model)
      expect(args.some(arg => arg.includes('service_tier'))).toBe(false)
    }
  }
})

test('a model outside the fast allowlist keeps its default service tier', () => {
  expect(codexArgs({ ...SPECS.developer, model: 'another-model' }, 'high', []).some(arg => arg.includes('service_tier'))).toBe(false)
})

test('astra caps xhigh at high without a service tier and other models retain their effort', () => {
  for (const base of Object.values(SPECS)) {
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol-astra', 'gpt-6-ASTRA']) {
      const spec = { ...base, model, effort: 'xhigh' as const }
      const args = codexArgs(spec, 'xhigh', [])
      expect(args).toContain('model_reasoning_effort="high"')
      expect(args).not.toContain('model_reasoning_effort="xhigh"')
      expect(args.some(arg => arg.includes('service_tier'))).toBe(false)
      for (const effort of ['low', 'medium', 'high'] as const) expect(codexArgs(spec, effort, [])).toContain(`model_reasoning_effort="${effort}"`)
    }
    expect(codexArgs(base, 'xhigh', [])).toContain('model_reasoning_effort="xhigh"')
  }
})
