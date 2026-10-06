import type { Probe } from './probe'

export type Outcome =
  | { kind: 'empty' }
  | { kind: 'commits'; commits: number; dirty: boolean }
  | { kind: 'dirty' }
  | { kind: 'unknown'; reason: string }

const GIT_MS = 15_000

export const branchFor = (id: string): string => `threads/${id}`

const git = async (probe: Probe, args: string[], cwd: string): Promise<{ ok: true; out: string } | { ok: false; reason: string }> => {
  try {
    const done = await probe.run(['git', ...args], { cwd, timeoutMs: GIT_MS })

    return done.exitCode === 0 ? { ok: true, out: done.stdout.trim() } : { ok: false, reason: `git ${args[0]} failed (exit ${done.exitCode})` }
  } catch {
    return { ok: false, reason: `git ${args[0]} could not run` }
  }
}

/** The main checkout of the repository `cwd` belongs to, also from a linked worktree; `undefined` outside a git repository. */
export const repoParent = async (probe: Probe, cwd: string): Promise<string | undefined> => {
  const common = await git(probe, ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)

  return common.ok && common.out.endsWith('/.git') ? common.out.slice(0, -'/.git'.length) : undefined
}

export const currentCommit = async (probe: Probe, cwd: string): Promise<string | undefined> => {
  const head = await git(probe, ['rev-parse', 'HEAD'], cwd)

  return head.ok && head.out !== '' ? head.out : undefined
}

/**
 * What is in a helper's worktree. Only `empty` allows removing it: nothing changed, ignored or
 * untracked, no submodule, still on its own branch at the commit it started from. Any doubt is `unknown`.
 */
export const classify = async (probe: Probe, a: { path: string; base: string; branch: string }): Promise<Outcome> => {
  const status = await git(probe, ['status', '--porcelain', '--ignored'], a.path)
  const head = await git(probe, ['rev-parse', 'HEAD'], a.path)
  const branch = await git(probe, ['rev-parse', '--abbrev-ref', 'HEAD'], a.path)
  const ahead = await git(probe, ['rev-list', '--count', `${a.base}..HEAD`], a.path)
  const submodules = await git(probe, ['submodule', 'status'], a.path)

  for (const asked of [status, head, branch, ahead, submodules]) {
    if (!asked.ok) {
      return { kind: 'unknown', reason: asked.reason }
    }
  }

  if (!status.ok || !head.ok || !branch.ok || !ahead.ok || !submodules.ok) {
    return { kind: 'unknown', reason: 'git failed' }
  }

  if (branch.out !== a.branch) {
    return { kind: 'unknown', reason: `the worktree is on ${branch.out}, not ${a.branch}` }
  }

  const commits = Number(ahead.out)
  const isDirty = status.out !== '' || submodules.out !== ''

  if (head.out !== a.base) {
    return Number.isInteger(commits) && commits > 0 ? { kind: 'commits', commits, dirty: isDirty } : { kind: 'unknown', reason: 'HEAD moved without new commits' }
  }

  return isDirty ? { kind: 'dirty' } : { kind: 'empty' }
}
