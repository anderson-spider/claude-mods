import { expect, test } from 'claude-code/testing'
import { DEFAULT_CAPS, capped, capsOf } from '../hooks/caps'

test('without the option the read-only built-in agents are capped, none turns caps off, and bad pairs are named', () => {
  expect(DEFAULT_CAPS).toBe('Explore=medium,web-fetch=medium,claude-code-guide=low,statusline-setup=low')
  expect(capsOf(undefined).caps).toEqual({ Explore: 'medium', 'web-fetch': 'medium', 'claude-code-guide': 'low', 'statusline-setup': 'low' })
  expect(capsOf('  ').caps).toEqual(capsOf(undefined).caps)
  expect(capsOf('none')).toEqual({ caps: {}, invalid: [] })
  expect(capsOf(' my:agent = high ,Plan=max,=low,a=b=c,x y=low')).toEqual({ caps: { 'my:agent': 'high' }, invalid: ['Plan=max', '=low', 'a=b=c', 'x y=low'] })
})

test("a cap lowers only a higher pick and says it applied; a type without a cap keeps Jev's effort", () => {
  const caps = capsOf(undefined).caps
  expect(capped('xhigh', 'Explore', caps)).toEqual({ effort: 'medium', cap: 'medium' })
  expect(capped('medium', 'Explore', caps)).toEqual({ effort: 'medium', cap: null })
  expect(capped('low', 'Explore', caps)).toEqual({ effort: 'low', cap: null })
  expect(capped('xhigh', 'general-purpose', caps)).toEqual({ effort: 'xhigh', cap: null })
})
