import { expect, test } from 'claude-code/testing'
import { sameWorkspace, workspaceOf } from '../hooks/workspace'

const paths = (top: string, prefix: string, gitDir: string, common: string) => `${top}\n${prefix}\n${gitDir}\n${common}\n`

test('a main checkout is named by its repository, the folder within it and the branch, never a whole path', () => {
  expect(workspaceOf('/home/me/dev/mods', paths('/home/me/dev/mods', '', '/home/me/dev/mods/.git', '/home/me/dev/mods/.git'), 'main\n'))
    .toEqual({ repo: 'mods', branch: 'main' })
  expect(workspaceOf('/home/me/dev/mods/plugins', paths('/home/me/dev/mods', 'plugins/', '/home/me/dev/mods/.git', '/home/me/dev/mods/.git'), 'main\n'))
    .toEqual({ repo: 'mods', sub: 'plugins', branch: 'main' })
  expect(workspaceOf('/home/me/dev/mods/plugins/session-hud/hooks', paths('/home/me/dev/mods', 'plugins/session-hud/hooks/', '/home/me/dev/mods/.git', '/home/me/dev/mods/.git'), 'main\n'))
    .toEqual({ repo: 'mods', sub: '…/hooks', branch: 'main' })
})

test('a linked worktree is named by the main repository and marked; a detached head names no branch', () => {
  const linked = paths('/home/me/dev/mods-worktrees/feature', '', '/home/me/dev/mods/.git/worktrees/feature', '/home/me/dev/mods/.git')
  expect(workspaceOf('/home/me/dev/mods-worktrees/feature', linked, 'me/feature\n')).toEqual({ repo: 'mods', branch: 'me/feature', worktree: true })
  expect(workspaceOf('/home/me/dev/mods-worktrees/feature', linked, '')).toEqual({ repo: 'mods', worktree: true })
})

test('outside a repository only the folder is named, and names lose control characters and are cut when long', () => {
  expect(workspaceOf('/home/me/notes/', undefined, undefined)).toEqual({ repo: 'notes' })
  expect(workspaceOf('/', undefined, undefined)).toBeUndefined()
  expect(workspaceOf('/home/me/a\u001b[31mb', undefined, undefined)).toEqual({ repo: 'a[31mb' })
  const long = workspaceOf('/r', paths('/r', '', '/r/.git', '/r/.git'), `${'x'.repeat(80)}\n`)
  expect(long?.branch).toHaveLength(64)
  expect(long?.branch?.endsWith('…')).toBe(true)
})

test('two readings of the same place are the same workspace', () => {
  expect(sameWorkspace({ repo: 'mods', branch: 'main' }, { repo: 'mods', branch: 'main' })).toBe(true)
  expect(sameWorkspace({ repo: 'mods', branch: 'main' }, { repo: 'mods', branch: 'dev' })).toBe(false)
  expect(sameWorkspace(undefined, undefined)).toBe(true)
})
