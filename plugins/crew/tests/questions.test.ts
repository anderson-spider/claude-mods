import { expect, test } from 'claude-code/testing'
import { MODELS } from '../hooks/agents'
import { DEPTH_BOUNDS, DESCRIPTION_CHARS, JEV_MODEL, PROMPT_CHARS, QUESTIONS, TIER_MIN_CONFIDENCE } from '../hooks/questions'

test('the tier question offers exactly the model tiers the routing may choose', () => {
  expect(Object.keys(QUESTIONS.tier.criteria)).toEqual([...MODELS])
  expect(QUESTIONS.tier.type).toBe('choice')
  expect(QUESTIONS.reasoning_depth.type).toBe('score')
})

test('the thresholds are ordered and the pinned model is an id the log accepts', () => {
  expect(DEPTH_BOUNDS[0]).toBeLessThan(DEPTH_BOUNDS[1])
  expect(TIER_MIN_CONFIDENCE).toBeGreaterThan(0)
  expect(TIER_MIN_CONFIDENCE).toBeLessThanOrEqual(1)
  expect(DESCRIPTION_CHARS).toBeLessThan(PROMPT_CHARS)
  expect(JEV_MODEL).toMatch(/^[\w.:-]{1,64}$/)
})
