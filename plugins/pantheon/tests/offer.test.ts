import { describe, expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG } from '../hooks/defaults'
import { isOffered } from '../hooks/roles'

describe('agent offer', () => {
  test('active native roles and Claude seats are offered', () => {
    for (const agent of ['pantheon:oracle', 'pantheon:designer', 'pantheon:councillor-beta']) {
      expect(isOffered(DEFAULT_CONFIG, agent)).toBe(true)
    }
  })

  test('disabled native roles are hidden', () => {
    const config = { ...DEFAULT_CONFIG, disabledAgents: ['oracle'] }
    expect(isOffered(config, 'pantheon:oracle')).toBe(false)
    expect(isOffered(config, 'pantheon:designer')).toBe(true)
  })

  test('removed seat and seats switched to Codex are hidden', () => {
    expect(isOffered({ ...DEFAULT_CONFIG, council: { seats: {} } }, 'pantheon:councillor-beta')).toBe(false)
    expect(isOffered(DEFAULT_CONFIG, 'pantheon:councillor-alpha')).toBe(false)
    expect(isOffered(DEFAULT_CONFIG, 'pantheon:councillor-toString')).toBe(false)
  })

  test('disabled council hides all its native seats', () => {
    const config = { ...DEFAULT_CONFIG, disabledAgents: ['council'] }
    expect(isOffered(config, 'pantheon:councillor-beta')).toBe(false)
    expect(isOffered(config, 'pantheon:oracle')).toBe(true)
  })

  test('seat disable names work for the logical and native names', () => {
    for (const name of ['councillor:beta', 'councillor-beta']) {
      expect(isOffered({ ...DEFAULT_CONFIG, disabledAgents: [name] }, 'pantheon:councillor-beta')).toBe(false)
    }
  })

  test('unknown Pantheon types and Codex roles cannot be offered as native agents', () => {
    expect(isOffered(DEFAULT_CONFIG, 'pantheon:missing')).toBe(false)
    expect(isOffered(DEFAULT_CONFIG, 'pantheon:fixer')).toBe(false)
  })

  test('non-Pantheon agents are always offered', () => {
    const config = { ...DEFAULT_CONFIG, disabledAgents: ['oracle', 'council', 'Explore'] }
    for (const agent of ['Explore', 'other:oracle', 'pantheonish:oracle', 'oracle']) {
      expect(isOffered(config, agent)).toBe(true)
    }
  })
})
