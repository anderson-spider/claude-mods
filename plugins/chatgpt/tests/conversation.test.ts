import { expect, test } from 'claude-code/testing'
import { send } from '../hooks/conversation'
import { printed } from './helpers'

test('send reports why the prompt could not be sent, and nothing on success', async () => {
  const answering = (value: unknown) => ({ js: async () => printed(value) })
  expect(await send(answering({ sent: false, reason: 'no composer' }), 't1', 'hello')).toEqual({ ok: false, text: 'Could not send the prompt: no composer.' })
  expect(await send(answering({ sent: true }), 't1', 'hello')).toEqual({ ok: true })
})
