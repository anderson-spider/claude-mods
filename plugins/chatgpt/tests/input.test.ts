import { expect, test } from 'claude-code/testing'
import { mimeOf } from '../hooks/files'
import { readAttachments } from '../hooks/input'
import { inputFor } from '../hooks/scripts'

test('attachment checks accept the size boundary and stop before later files on failure', async () => {
  const calls: string[] = []
  const files = { stat: async (path: string) => {
    calls.push(path)
    if (path === '/missing') throw new Error('absent')
    return { size: 4 * 1024 * 1024 + (path === '/large' ? 1 : 0) }
  } }
  expect(await readAttachments(files, ['/ref.PNG'])).toEqual([{ name: 'ref.PNG', type: 'image/png', path: '/ref.PNG' }])
  expect(await readAttachments(files, ['relative', '/later'])).toBe('relative must be an absolute path.')
  expect(await readAttachments(files, ['/large', '/later'])).toBe('/large is over 4 MiB.')
  expect(await readAttachments(files, ['/missing', '/later'])).toBe('Could not read /missing (absent).')
  expect(calls).toEqual(['/ref.PNG', '/large', '/missing'])
})

test('mimeOf and inputFor pick the type and the file input of an attachment', () => {
  expect(mimeOf('/x/notes.md')).toBe('text/markdown')
  expect(mimeOf('/x/report.PDF')).toBe('application/pdf')
  expect(mimeOf('/x/main.rs')).toBe('text/plain')
  expect(mimeOf('/x/ref.png')).toBe('image/png')
  expect(inputFor('image/png')).toBe('input[type=file][accept="image/*"]')
  expect(inputFor('application/pdf')).toContain(':not([accept])')
})
