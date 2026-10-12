import { expect, test } from 'claude-code/testing'

test('/codex-models:status answers with text', async $ => {
  const out = await $.command.run({ command: 'codex-models:status', args: '', origin: { kind: 'composer' } } as never)

  expect(out.text).toContain('codex-models')
})
