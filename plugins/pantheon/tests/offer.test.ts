import { describe, expect, test } from 'claude-code/testing'
import { CLAUDE, CODEX, MIXED } from './fixtures/profiles'
import { isOffered } from '../hooks/roles'

describe('agent offer', () => {
  test('role offers follow their configured engines', () => {
    for (const role of ['explorer', 'librarian', 'fixer']) expect(isOffered(CLAUDE, `pantheon:${role}`)).toBe(true)
    for (const role of ['oracle', 'designer', 'councillor-beta']) expect(isOffered(CODEX, `pantheon:${role}`)).toBe(false)
    expect(isOffered(MIXED, 'pantheon:fixer')).toBe(false)
    expect(isOffered(MIXED, 'pantheon:oracle')).toBe(true)
    expect(isOffered({ ...CLAUDE, disabledAgents: ['explorer'] }, 'pantheon:explorer')).toBe(false)
  })

  test('active native roles and Claude seats are offered', () => {
    for (const agent of ['pantheon:oracle', 'pantheon:designer', 'pantheon:councillor-beta']) {
      expect(isOffered(MIXED, agent)).toBe(true)
    }
  })

  test('disabled native roles are hidden', () => {
    const config = { ...MIXED, disabledAgents: ['oracle'] }
    expect(isOffered(config, 'pantheon:oracle')).toBe(false)
    expect(isOffered(config, 'pantheon:designer')).toBe(true)
  })

  test('removed seat and seats switched to Codex are hidden', () => {
    expect(isOffered({ ...MIXED, council: { seats: {} } }, 'pantheon:councillor-beta')).toBe(false)
    expect(isOffered(MIXED, 'pantheon:councillor-alpha')).toBe(false)
    expect(isOffered(MIXED, 'pantheon:councillor-toString')).toBe(false)
  })

  test('disabled council hides all its native seats', () => {
    const config = { ...MIXED, disabledAgents: ['council'] }
    expect(isOffered(config, 'pantheon:councillor-beta')).toBe(false)
    expect(isOffered(config, 'pantheon:oracle')).toBe(true)
  })

  test('seat disable names work for the logical and native names', () => {
    for (const name of ['councillor:beta', 'councillor-beta']) {
      expect(isOffered({ ...MIXED, disabledAgents: [name] }, 'pantheon:councillor-beta')).toBe(false)
    }
  })

  test('unknown Pantheon types and Codex roles cannot be offered as native agents', () => {
    expect(isOffered(MIXED, 'pantheon:missing')).toBe(false)
    expect(isOffered(MIXED, 'pantheon:fixer')).toBe(false)
  })

  test('non-Pantheon agents are always offered', () => {
    const config = { ...MIXED, disabledAgents: ['oracle', 'council', 'Explore'] }
    for (const agent of ['Explore', 'other:oracle', 'pantheonish:oracle', 'oracle']) {
      expect(isOffered(config, agent)).toBe(true)
    }
  })
})
