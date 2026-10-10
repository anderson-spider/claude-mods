import { describe, expect, test } from 'claude-code/testing'
import { DEFAULTS } from './fixtures/config'
import { isOffered } from '../hooks/roles'

describe('agent offer', () => {
  test('every role and default seat is offered', () => {
    for (const role of ['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux', 'councillor-alpha', 'councillor-beta']) {
      expect(isOffered(DEFAULTS, `pantheon:${role}`)).toBe(true)
    }
  })

  test('disabled native roles are hidden', () => {
    const config = { ...DEFAULTS, disabledAgents: ['architect'] }
    expect(isOffered(config, 'pantheon:architect')).toBe(false)
    expect(isOffered(config, 'pantheon:ux')).toBe(true)
  })

  test('a disabled qa is hidden', () => {
    const config = { ...DEFAULTS, disabledAgents: ['qa'] }
    expect(isOffered(config, 'pantheon:qa')).toBe(false)
    expect(isOffered(config, 'pantheon:architect')).toBe(true)
  })

  test('the former role names are not offered', () => {
    for (const old of ['explorer', 'librarian', 'executor', 'designer', 'oracle', 'fixer']) {
      expect(isOffered(DEFAULTS, `pantheon:${old}`)).toBe(false)
    }
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
    expect(isOffered(config, 'pantheon:architect')).toBe(true)
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
    const config = { ...DEFAULTS, disabledAgents: ['architect', 'council', 'Explore'] }
    for (const agent of ['Explore', 'other:architect', 'pantheonish:architect', 'architect']) {
      expect(isOffered(config, agent)).toBe(true)
    }
  })
})
