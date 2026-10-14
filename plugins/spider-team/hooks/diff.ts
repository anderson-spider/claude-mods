// Fixed Git argv only. Neither the caller nor report prose chooses a command or checkout.
import type { Context } from '../types'
export type ProcessResult = { exitCode: number; stdout: string; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }
export type GitIo = { run: (argv: string[]) => Promise<ProcessResult> }
const HASH = /^[a-f0-9]{40,64}$/
export const DIFF_ERROR = 'spider-team: checkout or diff unavailable; review is BLOCKED.'
export const gitArgs = (cwd: string, args: string[]) => ['git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args]
export async function git(io: GitIo, cwd: string, args: string[]): Promise<string> {
  const r = await io.run(gitArgs(cwd, args))
  if (r.exitCode !== 0 || r.isStdoutTruncated || r.isStderrTruncated) throw new Error(DIFF_ERROR)
  return r.stdout
}
export async function captureBase(io: GitIo, root: string) {
  const base = (await git(io, root, ['rev-parse', '--verify', 'HEAD'])).trim()
  if (!HASH.test(base)) throw new Error(DIFF_ERROR)
  const commonDir = (await git(io, root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  if (!commonDir.startsWith('/')) throw new Error(DIFF_ERROR)
  return { base, commonDir }
}
export async function verifyCheckout(io: GitIo, run: Context, path: string, branch: string) {
  if (!run.base || !HASH.test(run.base) || !path.startsWith('/') || /[\r\n\0]/.test(path + branch) || !branch || path === run.root) throw new Error(DIFF_ERROR)
  if ((run.nativePath && run.nativePath !== path) || (run.nativeBranch && run.nativeBranch !== branch)) throw new Error(DIFF_ERROR)
  const top = (await git(io, path, ['rev-parse', '--show-toplevel'])).trim()
  const actualBranch = (await git(io, path, ['branch', '--show-current'])).trim()
  const common = (await git(io, path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  if (top !== path || actualBranch !== branch || common !== run.commonDir) throw new Error(DIFF_ERROR)
  await git(io, path, ['merge-base', '--is-ancestor', run.base, 'HEAD'])
}
export async function reviewDiff(io: GitIo, run: Context, file?: string): Promise<string> {
  const report = run.report
  if (run.role !== 'developer' || !run.finished || run.status !== 'done' || report?.status !== 'done' || !report.worktreePath || !report.worktreeBranch) throw new Error(DIFF_ERROR)
  const path = report.worktreePath
  await verifyCheckout(io, run, path, report.worktreeBranch)
  const status = await git(io, path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const flags = ['--no-ext-diff', '--no-textconv', '--no-renames']
  const committed = (await git(io, path, ['diff', ...flags, '--name-only', '-z', run.base!, 'HEAD', '--'])).split('\0').filter(Boolean)
  // Separate index and worktree changes: they can cancel in a combined `git diff HEAD`.
  const staged = (await git(io, path, ['diff', ...flags, '--cached', '--name-only', '-z', 'HEAD', '--'])).split('\0').filter(Boolean)
  const unstaged = (await git(io, path, ['diff', ...flags, '--name-only', '-z', '--'])).split('\0').filter(Boolean)
  const untracked = (await git(io, path, ['ls-files', '--others', '--exclude-standard', '-z', '--'])).split('\0').filter(Boolean)
  const files = [...new Set([...committed, ...staged, ...unstaged])]
  if (file === undefined) return JSON.stringify({ checkout: path, branch: report.worktreeBranch, base: run.base, status, files, untracked, partial: files.length > 0, instruction: 'Call diff with one listed file at a time; Read untracked files in this checkout.' })
  if (!files.includes(file) || file.startsWith('/') || file.split('/').includes('..') || /[\r\n\0]/.test(file)) throw new Error(DIFF_ERROR)
  const prior = await git(io, path, ['diff', ...flags, run.base!, 'HEAD', '--', file])
  const index = await git(io, path, ['diff', ...flags, '--cached', 'HEAD', '--', file])
  const edits = await git(io, path, ['diff', ...flags, '--', file])
  if (prior.length + index.length + edits.length > 64000) return JSON.stringify({ file, partial: true, reason: 'file-diff-too-large', instruction: 'Inspect the file with Read; this diff is not complete.' })
  return JSON.stringify({ file, committed: prior, staged: index, unstaged: edits, partial: false })
}
