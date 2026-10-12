import { expect, test } from 'claude-code/testing'
import { CODEX_MODELS } from '../hooks/native'
import { nativeCodexSpecs, SPECIALISTS } from '../hooks/agents'

test('the fixed map assigns exactly the five specialist roles to their Codex models', () => {
  expect(CODEX_MODELS).toEqual({
    'code-reader': 'gpt-6-luna', research: 'gpt-6-luna',
    designer: 'gpt-6.1-sol', developer: 'gpt-6.1-sol',
    architect: 'gpt-6-astra',
  })
  expect(Object.keys(CODEX_MODELS)).toEqual(SPECIALISTS.map(s => s.name))
  const twins = nativeCodexSpecs(CODEX_MODELS)
  expect(twins.map(twin => [twin.name, twin.model])).toEqual(
    Object.entries(CODEX_MODELS).map(([role, model]) => [`${role}-codex`, model]),
  )
  for (const [i, twin] of twins.entries()) {
    expect(twin.prompt).toBe(SPECIALISTS[i]?.prompt)
    expect(twin.tools).toEqual(SPECIALISTS[i]?.tools)
    expect(twin.effort).toBe(SPECIALISTS[i]?.effort)
  }
})
