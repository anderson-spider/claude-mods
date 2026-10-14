import { expect, test } from 'claude-code/testing'
import { paint, paletteOf } from '../hooks/palette'

test('a full-colour dark or automatic theme takes the design palette; light, ANSI and unknown keep theme keys', () => {
  for (const theme of ['dark', 'dark-daltonized', 'auto']) expect(paletteOf(theme)).toBe('mockup')
  for (const theme of ['dark-ansi', 'light', 'light-ansi', '', 3, undefined]) expect(paletteOf(theme)).toBe('theme')
})

test('the design palette paints the model orange, the bars yellow and an alert red; the theme palette uses theme keys', () => {
  expect(paint('mockup', 'model')).toEqual({ color: '#d97757', bold: true })
  expect(paint('mockup', 'bar')).toEqual({ color: '#e5c07b' })
  expect(paint('theme', 'model')).toEqual({ color: 'claude', bold: true })
  expect(paint('theme', 'secondary')).toEqual({ dimColor: true })
  expect(paint('mockup', 'danger')).toEqual({ color: '#e06c75', bold: true })
  expect(paint('theme', 'danger')).toEqual({ color: 'error', bold: true })
})
