import { expect, test } from 'claude-code/testing'
import { paint, paletteOf } from '../hooks/hud/palette'

test('a full-colour dark or automatic theme takes the design palette; light, ANSI and unknown keep theme keys', () => {
  expect(paletteOf('dark')).toBe('mockup')
  expect(paletteOf('auto')).toBe('mockup')
  expect(paletteOf('dark-daltonized')).toBe('mockup')
  for (const theme of ['dark-ansi', 'light', 'light-daltonized', 'light-ansi', '', 3, undefined]) expect(paletteOf(theme)).toBe('theme')
})

test('the design palette paints each box and state in its fixed colour, and the theme palette in theme keys', () => {
  expect(paint('mockup', 'info')).toEqual({ color: '#61afef' })
  expect(paint('mockup', 'title')).toEqual({ color: '#e5c07b', bold: true })
  expect(paint('mockup', 'pill-running')).toEqual({ color: '#4fb383', backgroundColor: '#1d3a2e' })
  expect(paint('mockup', 'secondary')).toEqual({ color: '#8a8f98' })
  expect(paint('theme', 'info')).toEqual({ color: 'permission' })
  expect(paint('theme', 'secondary')).toEqual({ dimColor: true })
  expect(paint('theme', 'pill-running')).toEqual({ color: 'success' })
  expect(paint('theme', 'plain', true)).toEqual({ bold: true })
  expect(paint('mockup', 'success', true)).toEqual({ color: '#4fb383', bold: true })
})
