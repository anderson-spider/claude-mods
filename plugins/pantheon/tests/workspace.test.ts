import { expect, test } from 'claude-code/testing'
import { authorizedRoot } from '../hooks/workspace'

test('authorized root is the repository top level or the session cwd outside Git', () => {
  expect(authorizedRoot('/repo/sub', '/repo')).toBe('/repo')
  expect(authorizedRoot('/session', undefined)).toBe('/session')
})
