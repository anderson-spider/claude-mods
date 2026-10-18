import { expect, test } from 'claude-code/testing'
import { DEFAULTS, configOf } from '../hooks/config'

test('defaults are language auto, autoOpen team, everything shown, animations on, expanded, history 200', () => {
  expect(DEFAULTS).toEqual({ language: 'auto', autoOpen: 'team', showCost: true, showTokens: true, showContext: true, animations: true, compactMode: false, historyLimit: 200 })
  expect(configOf({})).toEqual({ config: DEFAULTS, invalid: [] })
})

test('a wrong kind or out-of-range value falls back and is named', () => {
  const { config, invalid } = configOf({ autoOpen: 'always', historyLimit: 5, showCost: 'yes', language: 'pt-BR', compactMode: true })
  expect(config.autoOpen).toBe('team')
  expect(config.historyLimit).toBe(200)
  expect(config.showCost).toBe(true)
  expect(config.language).toBe('pt-BR')
  expect(config.compactMode).toBe(true)
  expect(invalid).toEqual(['autoOpen', 'showCost', 'historyLimit'])
})

test('historyLimit takes integers 20 to 1000', () => {
  expect(configOf({ historyLimit: 20 }).config.historyLimit).toBe(20)
  expect(configOf({ historyLimit: 1000 }).config.historyLimit).toBe(1000)
  expect(configOf({ historyLimit: 19.5 }).config.historyLimit).toBe(200)
  expect(configOf({ historyLimit: 1001 }).invalid).toEqual(['historyLimit'])
})
