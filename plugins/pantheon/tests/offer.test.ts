import { describe, expect, test } from 'claude-code/testing'
import { DEFAULTS } from './fixtures/config'
import { isOffered } from '../hooks/roles'

describe('agent offer', () => {
  test('every role and default seat is offered', () => {
    for (const role of ['explorer', 'librarian', 'executor', 'oracle', 'designer', 'git', 'councillor-alpha', 'councillor-beta']) {
      expect(isOffered(DEFAULTS, `pantheon:${role}`)).toBe(true)
    }
  })

  test('disabled native roles are hidden', () => {
    const config = { ...DEFAULTS, disabledAgents: ['oracle'] }
    expect(isOffered(config, 'pantheon:oracle')).toBe(false)
    expect(isOffered(config, 'pantheon:designer')).toBe(true)
  })

  test('removed seat and unknown seats are hidden', () => {
    expect(isOffered({ ...DEFAULTS, council: { seats: {} } }, 'pantheon:councillor-beta')).toBe(false)
    expect(isOffered(DEFAULTS, 'pantheon:councillor-gamma')).toBe(false)
    expect(isOffered(DEFAULTS, 'pantheon:councillor-toString')).toBe(false)
  })

  test('disabled council hides all its seats', () => {
    const config = { ...DEFAULTS, disabledAgents: ['council'] }
    expect(isOffered(config, 'pantheon:councillor-alpha')).toBe(false)
    expect(isOffered(config, 'pantheon:councillor-beta')).toBe(false)
    expect(isOffered(config, 'pantheon:oracle')).toBe(true)
  })

  test('seat disable names work for the logical and native names', () => {
    for (const name of ['councillor:beta', 'councillor-beta']) {
      expect(isOffered({ ...DEFAULTS, disabledAgents: [name] }, 'pantheon:councillor-beta')).toBe(false)
    }
    expect(isOffered({ ...DEFAULTS, disabledAgents: ['councillor:beta'] }, 'pantheon:councillor-alpha')).toBe(true)
  })

  test('unknown Pantheon types are not offered', () => {
    expect(isOffered(DEFAULTS, 'pantheon:missing')).toBe(false)
  })

  test('non-Pantheon agents are always offered', () => {
    const config = { ...DEFAULTS, disabledAgents: ['oracle', 'council', 'Explore'] }
    for (const agent of ['Explore', 'other:oracle', 'pantheonish:oracle', 'oracle']) {
      expect(isOffered(config, agent)).toBe(true)
    }
  })
})
