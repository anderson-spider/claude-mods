import { expect, test } from 'claude-code/testing'
import type { Attachment } from '../hooks/model'
import { base64Of, bytesOf, uploadFiles } from '../hooks/upload'

test('base64 round-trips across the slice boundary and the bytes match the file', () => {
  const bytes = Uint8Array.from({ length: 70_001 }, (_, i) => i % 251)
  expect(bytesOf(base64Of(bytes))).toEqual(bytes)
  expect(base64Of(new Uint8Array([137, 80, 78, 71]))).toBe('iVBORw==')
})

test('uploadFiles keeps the name and MIME type of each attachment, and throws the page reason off chatgpt.com', async () => {
  const scripts: string[] = []
  const files: Attachment[] = [{ name: 'notes.txt', type: 'text/plain', path: '/x/notes.txt' }]
  await uploadFiles(
    async body => {
      scripts.push(body)
      return '{"uploaded":true}'
    },
    async () => new Uint8Array([104, 105]),
    'input[type=file]',
    files,
  )
  expect(scripts[0]).toContain('"name":"notes.txt"')
  expect(scripts[0]).toContain('"type":"text/plain"')
  expect(scripts[0]).not.toContain('application/octet-stream')
  const error = await uploadFiles(async () => '{"uploaded":false,"reason":"not on chatgpt.com"}', async () => new Uint8Array(), 'input', files).catch(e => e)
  expect(String(error)).toContain('could not attach notes.txt: not on chatgpt.com')
})
