import { describe, expect, test } from 'claude-code/testing'
import { authorizedRoot, checkCwd } from '../hooks/workspace'
import type { StatReal } from '../hooks/types'

const identity: StatReal = async path => path

describe('workspace', () => {
  test('authorized root is the repository top level or the session cwd outside Git', () => {
    expect(authorizedRoot('/repo/sub', '/repo')).toBe('/repo')
    expect(authorizedRoot('/session', undefined)).toBe('/session')
  })

  test('root itself and cwd inside root are accepted', async () => {
    expect(await checkCwd(identity, '/repo', '/repo')).toBe('/repo')
    expect(await checkCwd(identity, '/repo', '/repo/sub/deep')).toBe('/repo/sub/deep')
  })

  test('symlink resolving outside root is refused', async () => {
    const stat: StatReal = async path => path === '/repo/link' ? '/etc' : path
    expect(await checkCwd(stat, '/repo', '/repo/link')).toEqual({ error: expect.stringContaining('outside') })
  })

  test('a symlink inside root returns the resolved cwd', async () => {
    const stat: StatReal = async path => path === '/repo/link' ? '/repo/target' : path
    expect(await checkCwd(stat, '/repo', '/repo/link')).toBe('/repo/target')
  })

  test('root is resolved before checking the cwd', async () => {
    const paths: Record<string, string> = { '/alias': '/real/repo', '/alias/sub': '/real/repo/sub' }
    expect(await checkCwd(async path => paths[path], '/alias', '/alias/sub')).toBe('/real/repo/sub')
  })

  test('prefix trick /repo2 is not inside /repo', async () => {
    expect(await checkCwd(identity, '/repo', '/repo2/sub')).toEqual({ error: expect.stringContaining('outside') })
  })

  test('resolved parent traversal outside root is refused', async () => {
    const stat: StatReal = async path => path === '/repo/../other' ? '/other' : path
    expect(await checkCwd(stat, '/repo', '/repo/../other')).toEqual({ error: expect.stringContaining('outside') })
  })

  test('trailing separators do not break segment comparison', async () => {
    expect(await checkCwd(identity, '/repo/', '/repo/sub/')).toBe('/repo/sub')
    expect(await checkCwd(identity, '/repo/', '/repo/')).toBe('/repo')
    expect(await checkCwd(identity, '/', '/child')).toBe('/child')
  })

  test('missing root or cwd is refused', async () => {
    expect(await checkCwd(async () => undefined, '/missing', '/missing/sub'))
      .toEqual({ error: expect.any(String) })
    expect(await checkCwd(async path => path === '/repo' ? path : undefined, '/repo', '/repo/missing'))
      .toEqual({ error: expect.any(String) })
  })

  test('stat failure is an error rather than authorization', async () => {
    expect(await checkCwd(async () => { throw new Error('permission denied') }, '/repo', '/repo/sub'))
      .toEqual({ error: expect.stringContaining('permission denied') })
  })
})
