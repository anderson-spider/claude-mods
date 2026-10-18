// Name search over an index of relative paths. The index comes from `git ls-files` in a repository, else from a
// bounded walk (register.tsx); here it is only matched and ranked.
import type { Config } from './config'
import { isHiddenName } from './tree'

/** The most paths an index holds and the most hits a search shows. */
export const MAX_INDEX = 50_000
export const MAX_HITS = 200

const baseOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1)

/** How well `rel` matches `query` (lower-cased), higher better; -1 for no match. */
export function score(rel: string, query: string, mode: Config['search']): number {
  const path = rel.toLowerCase()
  const name = baseOf(path)
  if (name === query) return 1000 - path.length / 1000
  if (name.startsWith(query)) return 800 - path.length / 1000
  const inName = name.indexOf(query)
  if (inName >= 0) return 600 - inName - path.length / 1000
  if (path.includes(query)) return 400 - path.length / 1000
  if (mode === 'substring') return -1
  // Fuzzy: every query character in order; fewer gaps rank higher.
  let at = -1
  let gaps = 0
  for (const c of query) {
    const next = path.indexOf(c, at + 1)
    if (next < 0) return -1
    if (at >= 0 && next > at + 1) gaps++
    at = next
  }
  return 200 - gaps * 10 - path.length / 1000
}

export type SearchOptions = { mode: Config['search']; showHidden: boolean }

/** The best `MAX_HITS` paths for `query`, best first; hidden paths only when they are shown. An empty query has none. */
export function rank(index: readonly string[], query: string, options: SearchOptions): string[] {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return []
  const scored: { rel: string; score: number }[] = []
  for (const rel of index) {
    if (!options.showHidden && rel.split('/').some(isHiddenName)) continue
    const value = score(rel, wanted, options.mode)
    if (value >= 0) scored.push({ rel, score: value })
  }
  scored.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : 1))
  return scored.slice(0, MAX_HITS).map(one => one.rel)
}

/** Every file of `files` and each directory above it, once, so directories are found by name too. */
export function withDirectories(files: readonly string[]): string[] {
  const all = new Set<string>()
  for (const file of files) {
    if (all.size >= MAX_INDEX) break
    all.add(file)
    let slash = file.lastIndexOf('/')
    while (slash > 0) {
      const dir = file.slice(0, slash)
      if (all.has(dir)) break
      all.add(dir)
      slash = dir.lastIndexOf('/')
    }
  }
  return [...all]
}
