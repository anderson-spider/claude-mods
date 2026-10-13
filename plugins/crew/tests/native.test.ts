import { expect, test } from 'claude-code/testing'
import { CODEX_MODELS } from '../hooks/native'
import { nativeCodexSpecs, SPECIALISTS } from '../hooks/agents'

test('the fixed map assigns exactly the three helper roles to their Codex models', () => {
  expect(CODEX_MODELS).toEqual({ planner: 'gpt-6-astra', challenger: 'gpt-6-astra', digger: 'gpt-6-luna' })
  expect(Object.keys(CODEX_MODELS)).toEqual(SPECIALISTS.map(s => s.name))
  const twins = nativeCodexSpecs(CODEX_MODELS)
  expect(twins.map(twin => [twin.name, twin.model])).toEqual(
    Object.entries(CODEX_MODELS).map(([role, model]) => [`${role}-codex`, model]),
  )
  for (const [i, twin] of twins.entries()) {
    expect(twin.prompt).toBe(SPECIALISTS[i]?.prompt)
    expect(twin.tools).toEqual(SPECIALISTS[i]?.tools)
    expect(twin.effort).toBe('high')
  }
})
