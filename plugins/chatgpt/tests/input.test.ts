import { expect, test } from 'claude-code/testing'
import { extensionOf, fileName, limitMs, mimeOf, readAttachments, typeOf } from '../hooks/input'
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

test('image file names and types', () => {
  expect(fileName('Uma luminária de mesa', new Date('2026-10-06T12:00:00Z'), 'png')).toBe('20261006-120000-uma-luminaria-de-mesa.png')
  expect(extensionOf('image/webp')).toBe('webp')
  expect(extensionOf('image/unknown')).toBe('png')
  expect(typeOf('/x/Ref.JPG')).toBe('image/jpeg')
  expect(typeOf('/x/ref.bmp')).toBeUndefined()
})

test('mimeOf and inputFor pick the type and the file input of an attachment', () => {
  expect(mimeOf('/x/notes.md')).toBe('text/markdown')
  expect(mimeOf('/x/report.PDF')).toBe('application/pdf')
  expect(mimeOf('/x/main.rs')).toBe('text/plain')
  expect(mimeOf('/x/ref.png')).toBe('image/png')
  expect(inputFor('image/png')).toBe('input[type=file][accept="image/*"]')
  expect(inputFor('application/pdf')).toContain(':not([accept])')
})

test('limitMs reads minutes, falls back and caps', () => {
  expect(limitMs(undefined, 6)).toBe(360_000)
  expect(limitMs('abc', 6)).toBe(360_000)
  expect(limitMs(0, 6)).toBe(360_000)
  expect(limitMs(-3, 6)).toBe(360_000)
  expect(limitMs(NaN, 6)).toBe(360_000)
  expect(limitMs(0.5, 6)).toBe(30_000)
  expect(limitMs('12', 6)).toBe(720_000)
  expect(limitMs(1e9, 6)).toBe(86_400_000)
})
