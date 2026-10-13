import type { CrewPlanDisplay } from '../../types'
import type { RedactContext } from '../redact'
import { selectPlans } from './plan'

/** The plan files' host access: reads and the published display, never the host itself. */
export type PlanIo = {
  cwd(): Promise<string>
  /** Absence is asked of `exists`: a stat rejection reaches a hook without its `code`. */
  exists(path: string): Promise<boolean>
  /** The stat of the path with its real destination (`realPath`) when resolvable. */
  stat(path: string): Promise<{ kind: string; isLink: boolean; realPath?: string }>
  list(path: string): Promise<{ name: string; kind: string; isLink: boolean }[]>
  read(path: string): Promise<string>
  publish(change: (list: CrewPlanDisplay[]) => CrewPlanDisplay[]): Promise<void>
  /** What redaction turns into `~` and repo-relative paths. */
  context(): Promise<RedactContext>
  log(text: string): void
}

type Directory = { path: string; real: string }

export function normalizePath(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** A missing target can be removed; any other filesystem error cannot prove absence. */
export function missingPlan(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** A plan the filesystem no longer has: a missing-path code, or `exists` saying so. Any other failure proves nothing. */
async function removedPlan(io: PlanIo, path: string, error: unknown): Promise<boolean> {
  if (missingPlan(error)) return true
  return io.exists(path).then(present => !present, () => false)
}

async function planDirectory(io: PlanIo): Promise<Directory | undefined> {
  const cwd = normalizePath(await io.cwd())
  const path = `${cwd}/.crew/plans`
  // A stat rejection reaches a hook without its `code`, so absence is asked of `exists`: a repository with no plans is the default.
  if (!(await io.exists(path))) return undefined
  const root = await io.stat(cwd)
  const directory = await io.stat(path)
  if (root.kind !== 'dir' || directory.kind !== 'dir' || directory.isLink ||
    !root.realPath || !directory.realPath || normalizePath(directory.realPath) !== `${normalizePath(root.realPath)}/.crew/plans`) return undefined
  return { path, real: normalizePath(directory.realPath) }
}

async function planFile(io: PlanIo, directory: Directory, path: string): Promise<string | undefined> {
  const file = await io.stat(path)
  const real = file.realPath && normalizePath(file.realPath)
  const prefix = `${directory.real}/`
  const name = real?.startsWith(prefix) ? real.slice(prefix.length) : ''
  return file.kind === 'file' && !file.isLink && name && !name.includes('/') && name.endsWith('.md') ? name : undefined
}

async function planPath(io: PlanIo, path: unknown): Promise<string | undefined> {
  if (typeof path !== 'string') return undefined
  const directory = await planDirectory(io)
  if (!directory) return undefined
  const cwd = normalizePath(await io.cwd())
  const source = path.startsWith('/') ? path : `${cwd}/${path}`
  // A real destination is required, and only its canonical filename is retained as touched.
  return planFile(io, directory, source)
}

export type PlanRefresher = {
  /** One read of the plans directory; a call during a read schedules another snapshot after it. */
  refresh(io: PlanIo): Promise<void>
  /** A successful write to `path`: a plan file under the plans directory is retained as touched, then the plans are reread. */
  written(io: PlanIo, path: unknown): Promise<void>
}

/** The plan files' state: the single read flight, the last published bytes and the names written this session. */
export function createPlanRefresher(): PlanRefresher {
  let flight: Promise<void> | undefined
  let dirty = false
  let contents: string | undefined
  const touched = new Set<string>()

  function refresh(io: PlanIo): Promise<void> {
    if (flight) { dirty = true; return flight }
    const current = (async () => {
      do {
        dirty = false
        try {
          let directory: Directory | undefined
          try { directory = await planDirectory(io) }
          catch (error) { if (!missingPlan(error)) throw error }
          if (!directory) { await io.publish(() => []); contents = undefined; continue }
          // If listing is unavailable, written names are candidates, never exemptions from real-path validation.
          const names = await io.list(directory.path)
            .then(entries => entries.filter(entry => entry.kind === 'file' && !entry.isLink && entry.name.endsWith('.md')).map(entry => entry.name))
            .catch(() => [...touched])
          const files: { basename: string; text: string }[] = []
          let unreadable = false
          let loading = false
          for (const name of [...new Set([...names, ...touched])].sort()) {
            if (name.includes('/') || name === '.' || name === '..') continue
            const path = `${directory.path}/${name}`
            let valid: string | undefined
            try { valid = await planFile(io, directory, path) }
            catch (error) { if (!(await removedPlan(io, path, error))) unreadable = true; continue }
            if (valid !== name) continue
            if (contents === undefined && !loading) {
              loading = true
              await io.publish(() => [{ state: 'loading' as const }])
            }
            try { files.push({ basename: name, text: await io.read(path) }) }
            catch (error) { if (!(await removedPlan(io, path, error))) unreadable = true }
          }
          const text = JSON.stringify({ files, unreadable })
          if (text !== contents) {
            const selection = selectPlans(files, await io.context())
            await io.publish((): CrewPlanDisplay[] => unreadable ? [...selection, { state: 'unknown' }] : selection)
            contents = text
          }
        } catch {
          contents = undefined
          await io.publish(() => [{ state: 'unknown' as const }])
          io.log('crew HUD: plan refresh failed')
        }
      } while (dirty)
    })()
    flight = current.finally(() => { flight = undefined })
    return flight
  }

  async function written(io: PlanIo, path: unknown): Promise<void> {
    const name = await planPath(io, path)
    if (name) { touched.add(name); await refresh(io) }
  }

  return { refresh, written }
}
