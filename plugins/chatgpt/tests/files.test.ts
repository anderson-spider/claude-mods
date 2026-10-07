import { expect, test } from 'claude-code/testing'
import { extensionOf, fileName, typeOf } from '../hooks/files'

test('image file names and types', () => {
  expect(fileName('Uma luminária de mesa', new Date('2026-10-06T12:00:00Z'), 'png')).toBe('20261006-120000-uma-luminaria-de-mesa.png')
  expect(extensionOf('image/webp')).toBe('webp')
  expect(extensionOf('image/unknown')).toBe('png')
  expect(typeOf('/x/Ref.JPG')).toBe('image/jpeg')
  expect(typeOf('/x/ref.bmp')).toBeUndefined()
})
