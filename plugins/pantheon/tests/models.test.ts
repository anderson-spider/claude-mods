import { expect, test } from 'claude-code/testing'
import { isClaudeModel } from '../hooks/models'

test('Claude aliases, suffixes and ids', () => {
  for (const m of ['opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'default', 'inherit', 'opus[1m]', 'sonnet[1m]',
    'claude-opus-5-5', 'us.anthropic.claude-sonnet-5-5-v1:0', 'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-haiku-5-5'])
    expect(isClaudeModel(m)).toBe(true)
  for (const m of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'o9', 'opus-like']) expect(isClaudeModel(m)).toBe(false)
})
