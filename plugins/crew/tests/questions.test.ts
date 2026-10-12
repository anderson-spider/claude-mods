import { expect, test } from 'claude-code/testing'
import { DEPTH_HIGH, DEPTH_TIE, DESCRIPTION_CHARS, JEV_MODEL, PROMPT_CHARS, QUESTIONS } from '../hooks/questions'

test('Jev is asked only for reasoning depth, never a model', () => {
  expect(Object.keys(QUESTIONS)).toEqual(['reasoning_depth'])
  expect(QUESTIONS.reasoning_depth.type).toBe('score')
})

test('the thresholds are in range and the pinned model is an id the log accepts', () => {
  expect(DEPTH_HIGH).toBeGreaterThan(0)
  expect(DEPTH_HIGH).toBeLessThanOrEqual(4)
  expect(DEPTH_TIE).toBeLessThan(1)
  expect(DESCRIPTION_CHARS).toBeLessThan(PROMPT_CHARS)
  expect(JEV_MODEL).toMatch(/^[\w.:-]{1,64}$/)
})
