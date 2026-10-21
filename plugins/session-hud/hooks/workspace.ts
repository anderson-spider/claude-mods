// Where the session works, read from git's answers: the repository's name, the folder within it and the branch. Pure: no host access.
import type { SessionHudWorkspace } from '../types'

/** What register.tsx asks git: the working tree's root, the folder within it, the git dir and the common git dir, one per line, all absolute. */
export const REV_PARSE = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--show-prefix', '--git-dir', '--git-common-dir'] as const
/** The checked-out branch; empty on a detached head. */
export const BRANCH = ['branch', '--show-current'] as const

/** A name shown on the card: no control characters, at most `max` characters. */
const NAME_MAX = 48
function clean(text: string, max = NAME_MAX): string {
  const plain = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}
const lastName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

/**
 * The workspace as the card names it, never a whole path: the repository by its name (the main checkout's for a worktree),
 * the folder within it (`…/last` when deeper than one), the branch and whether this is a linked worktree. Outside a
 * repository (`paths` undefined) only the session folder's own name; undefined when not even that is known.
 */
export function workspaceOf(cwd: string, paths: string | undefined, branch: string | undefined): SessionHudWorkspace | undefined {
  const lines = paths?.split('\n').map(line => line.trim())
  if (!lines || lines.length < 4 || !lines[0] || !lines[3]) {
    const folder = clean(lastName(cwd))
    return folder ? { repo: folder } : undefined
  }
  const [, prefix = '', gitDir = '', common = ''] = lines
  const repo = clean(lastName(common.replace(/[\\/]+$/, '').replace(/[\\/]\.git$/, '')))
  if (!repo) return undefined
  const inner = prefix.replace(/[\\/]+$/, '')
  const sub = inner === '' ? undefined : clean(inner.includes('/') ? `…/${lastName(inner)}` : inner)
  const name = branch === undefined ? '' : clean(branch, 64)
  const worktree = gitDir !== '' && gitDir.replace(/[\\/]+$/, '') !== common.replace(/[\\/]+$/, '')
  return { repo, ...(sub ? { sub } : {}), ...(name ? { branch: name } : {}), ...(worktree ? { worktree: true as const } : {}) }
}

/** Whether two readings name the same place, so an unchanged one leaves the card as it was. */
export const sameWorkspace = (a: SessionHudWorkspace | undefined, b: SessionHudWorkspace | undefined): boolean =>
  a?.repo === b?.repo && a?.sub === b?.sub && a?.branch === b?.branch && a?.worktree === b?.worktree
