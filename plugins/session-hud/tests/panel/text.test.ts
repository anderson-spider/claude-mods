import { expect, test } from 'claude-code/testing'
import { cut, duration, fit, p, pad } from '../../hooks/panel/text'

test('text is cut with … at its width, padded to it, and a line of pieces is fit to it', () => {
  expect(cut('reviewer', 5)).toBe('revi…')
  expect(cut('Explore', 7)).toBe('Explore')
  expect(pad('Plan', 6)).toBe('Plan  ')
  expect(fit([p('abc'), p('def')], 5).map(piece => piece.text)).toEqual(['abc', 'd…'])
})

test('a duration reads as minutes and seconds, with hours from an hour', () => {
  expect(duration(61_000)).toBe('01:01')
  expect(duration(3_725_000)).toBe('1:02:05')
  expect(duration(-5)).toBe('00:00')
})
