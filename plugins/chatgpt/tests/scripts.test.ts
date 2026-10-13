import { expect, test } from 'claude-code/testing'
import { parseOutput, sendScript, uploadBody } from '../hooks/scripts'
import { printed } from './fake-page'

test('the send script checks it runs on chatgpt.com before it touches the composer', () => {
  const script = sendScript('hello')
  expect(script.trimStart().startsWith("if (location.origin !== 'https://chatgpt.com') return JSON.stringify({ sent: false, reason: 'not on chatgpt.com' });")).toBe(true)
  expect(script.indexOf('chatgpt.com')).toBeLessThan(script.indexOf('ClipboardEvent'))
})

test('sendScript embeds the prompt as a string literal', () => {
  const script = sendScript('line "1"\n`code` ${x}')
  expect(script).toContain(JSON.stringify('line "1"\n`code` ${x}'))
})

test('parseOutput reads the JSON a page script returns', () => {
  expect(parseOutput(printed({ a: 'x "y"\nz', b: [1] }))).toEqual({ a: 'x "y"\nz', b: [1] })
  expect(() => parseOutput('Error: no tab')).toThrow()
})

test('the page upload script first checks it runs on chatgpt.com', () => {
  expect(uploadBody('input[type=file]', []).trimStart().startsWith('if (location.origin !== "https://chatgpt.com") return')).toBe(true)
})
