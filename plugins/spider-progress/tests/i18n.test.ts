import { expect, test } from 'claude-code/testing'
import { STRINGS, langOf, t } from '../hooks/i18n'

test('langOf follows the option, then settings, then the locale, else English', () => {
  expect(langOf('en', 'Portuguese', { LANG: 'pt_BR.UTF-8' })).toBe('en')
  expect(langOf('pt-BR', 'English')).toBe('pt-BR')
  expect(langOf('auto', 'Português (Brasil)')).toBe('pt-BR')
  expect(langOf('auto', 'english', { LANG: 'pt_BR.UTF-8' })).toBe('en')
  expect(langOf('auto', undefined, { LC_ALL: '', LC_MESSAGES: 'pt_BR', LANG: 'en_US' })).toBe('pt-BR')
  expect(langOf('auto', undefined, { LANG: 'de_DE.UTF-8' })).toBe('en')
  expect(langOf('auto')).toBe('en')
  expect(langOf('auto', 'Brazilian Portuguese')).toBe('pt-BR')
  expect(langOf('auto', 'portugues')).toBe('pt-BR')
  expect(langOf('auto', 'pt')).toBe('pt-BR')
  expect(langOf('auto', 'pt-BR')).toBe('pt-BR')
  expect(langOf('auto', undefined, { LANG: 'pt_BR.UTF-8' })).toBe('pt-BR')
  expect(langOf('auto', 'Spanish (Latin America)')).toBe('en')
  expect(langOf('auto', 'ptolemaic')).toBe('en')
})

test('both languages have the same keys', () => {
  const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v).map(s => `${k}.${s}`) : [k])).sort()
  expect(keys(STRINGS['pt-BR'])).toEqual(keys(STRINGS.en))
  expect(t('pt-BR').phase.review).toBe('Revisão')
  expect(t('en').phase.review).toBe('Review')
})
