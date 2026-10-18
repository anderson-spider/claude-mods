// Git output read into the explorer's terms. register.tsx runs git by argv (no shell) and hands the text here.
import type { FileExplorerBranch, FileExplorerGit, FileExplorerGitCode } from '../types'
import { ancestors, join } from './paths'

export type GitCode = FileExplorerGitCode
export type Branch = FileExplorerBranch
export type GitStatus = FileExplorerGit

// A directory takes the strongest code under it, in this order.
const STRENGTH: readonly GitCode[] = ['U', 'D', 'M', 'R', 'A', '?']

/** The branch line of `git status -b`: `## main...origin/main [ahead 1, behind 2]`, a fresh or detached head. */
export function parseBranch(line: string): Branch {
  const text = line.replace(/^## /, '')
  const fresh = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(text)
  if (fresh) return { name: fresh[1] ?? '', ahead: 0, behind: 0 }
  if (text.startsWith('HEAD (no branch)')) return { name: 'detached', ahead: 0, behind: 0 }
  const [head = '', tracking] = text.split(' [', 2)
  const [name = '', upstream] = head.split('...', 2)
  const ahead = Number(/ahead (\d+)/.exec(tracking ?? '')?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(tracking ?? '')?.[1] ?? 0)
  return upstream ? { name, upstream, ahead, behind } : { name, ahead, behind }
}

/** One status entry's letter from its index (`x`) and work-tree (`y`) columns. */
export function codeOf(x: string, y: string): GitCode {
  if (x === '?' && y === '?') return '?'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'U'
  const column = y !== ' ' ? y : x
  if (column === 'D') return 'D'
  if (column === 'A') return 'A'
  if (column === 'R' || column === 'C') return 'R'
  return 'M'
}

/**
 * `git status --porcelain=v1 -b -z --untracked-files=all` under the repository at `top` (paths in its output are
 * relative to the top). A rename's second field, the old path, is skipped.
 */
export function parseStatus(text: string, top: string): Omit<GitStatus, 'lines' | 'dirs'> {
  const fields = text.split('\0')
  let branch: Branch = { name: '', ahead: 0, behind: 0 }
  const files: Record<string, GitCode> = {}
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field === '') continue
    if (field.startsWith('## ')) {
      branch = parseBranch(field)
      continue
    }
    const x = field[0] ?? ' '
    const y = field[1] ?? ' '
    files[join(top, field.slice(3))] = codeOf(x, y)
    if (x === 'R' || x === 'C') i++
  }
  return { branch, files }
}

/** `git diff --numstat -z HEAD`: lines added and removed per file; binary files (`-`) and renames' old paths left out. */
export function parseNumstat(text: string, top: string): GitStatus['lines'] {
  const lines: GitStatus['lines'] = {}
  const fields = text.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i] ?? '')
    if (!match) continue
    let path = match[3] ?? ''
    // A rename leaves the path empty and gives the old and new paths as the next two fields.
    if (path === '') {
      path = fields[i + 2] ?? ''
      i += 2
    }
    if (match[1] === '-' || path === '') continue
    lines[join(top, path)] = { added: Number(match[1]), removed: Number(match[2]) }
  }
  return lines
}

/** Each directory between `root` and a changed file, with the strongest code under it and how many changed files. */
export function rollUp(root: string, files: Readonly<Record<string, GitCode>>): GitStatus['dirs'] {
  const dirs: GitStatus['dirs'] = {}
  for (const [path, code] of Object.entries(files)) {
    for (const dir of ancestors(root, path)) {
      const seen = dirs[dir]
      if (!seen) dirs[dir] = { code, count: 1 }
      else dirs[dir] = { code: STRENGTH.indexOf(code) < STRENGTH.indexOf(seen.code) ? code : seen.code, count: seen.count + 1 }
    }
  }
  return dirs
}

/** The lines added and removed over every changed file. */
export function totals(lines: GitStatus['lines']): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const one of Object.values(lines)) {
    added += one.added
    removed += one.removed
  }
  return { added, removed }
}
