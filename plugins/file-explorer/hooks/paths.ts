// Path helpers over the one spelling the explorer keeps: forward slashes, no trailing slash, `.` and `..` folded.
// Windows paths keep their drive (`C:/repo`); the host's `$.fs` takes forward slashes there too.

/** The path with backslashes as slashes, duplicate slashes, `.` and `..` folded, and no trailing slash but the root's. */
export function normalize(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:/.exec(slashed)?.[0] ?? ''
  const rest = slashed.slice(drive.length)
  const isAbsolute = rest.startsWith('/')
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!isAbsolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  const body = parts.join('/')
  if (isAbsolute) return `${drive}/${body}`
  return drive + (body || '.')
}

export const isAbsolute = (path: string) => /^([A-Za-z]:)?[\\/]/.test(path)

/** `name` under `dir`, normalized. */
export const join = (dir: string, name: string) => normalize(`${dir}/${name}`)

/** `path` read against `cwd` when relative, normalized. */
export const resolve = (cwd: string, path: string) => normalize(isAbsolute(path) ? path : `${cwd}/${path}`)

/** The directory holding `path`; the root holds itself. */
export function parent(path: string): string {
  const index = path.lastIndexOf('/')
  if (index < 0) return '.'
  if (index === 0 || /^[A-Za-z]:$/.test(path.slice(0, index))) return path.slice(0, index + 1)
  return path.slice(0, index)
}

/** The last part of `path`. */
export const base = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path

/** True when `path` is `root` or lies under it. */
export function isInside(root: string, path: string): boolean {
  if (path === root) return true
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix)
}

/** `path` relative to `root` (`''` for the root itself); undefined outside it. */
export function relative(root: string, path: string): string | undefined {
  if (!isInside(root, path)) return undefined
  return path === root ? '' : path.slice(root.endsWith('/') ? root.length : root.length + 1)
}

/** The directories from `root` down to the one holding `path`, `root` first; empty outside `root` or for `root` itself. */
export function ancestors(root: string, path: string): string[] {
  const rel = relative(root, path)
  if (!rel) return []
  const dirs = [root]
  let dir = root
  for (const part of rel.split('/').slice(0, -1)) dirs.push((dir = join(dir, part)))
  return dirs
}

/** How a path is written in a prompt mention: `@path`, quoted when it holds a space or a quote-free shell break. */
export const mention = (rel: string) => (/[\s"]/.test(rel) ? `@"${rel.replace(/"/g, '')}"` : `@${rel}`)
