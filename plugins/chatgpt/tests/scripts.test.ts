import { expect, test } from 'claude-code/testing'
import { sendScript } from '../hooks/scripts'

test('the send script checks it runs on chatgpt.com before it touches the composer', () => {
  const script = sendScript('hello')
  expect(script.trimStart().startsWith("if (location.origin !== 'https://chatgpt.com') return JSON.stringify({ sent: false, reason: 'not on chatgpt.com' });")).toBe(true)
  expect(script.indexOf('chatgpt.com')).toBeLessThan(script.indexOf('ClipboardEvent'))
})
