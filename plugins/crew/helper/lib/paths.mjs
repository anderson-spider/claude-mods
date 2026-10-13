// Turns a lane's nominal cwd into the real directory a thread may write in, or a reason it may not. The lane is the
// thread's cwd, so what it resolves to is the whole boundary: symlinks are followed once, here, and what is left must be
// a real directory inside the repository and outside the places a turn must never be able to write.
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { laneCwd, laneOf } from './lanes.mjs'

const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

/**
 * `{ ok: true, cwd }` with the resolved directory for `role` in `repo`, or `{ ok: false, message }`.
 * `forbidden` are directories a lane may not be in or contain (the user's Codex and Claude homes, the helper itself);
 * the filesystem root and the user's home (and so every ancestor of it) are always refused.
 */
export const resolveLane = (role, repo, { home, forbidden = [], fs = { existsSync, lstatSync, mkdirSync, realpathSync, statSync } } = {}) => {
  const nominal = laneCwd(role, repo)

  if (nominal === undefined) {
    return { ok: false, message: 'repo must be an absolute path without ..' }
  }

  let real

  try {
    real = fs.realpathSync(repo)

    if (!fs.statSync(real).isDirectory()) {
      return { ok: false, message: 'repo is not a directory' }
    }
  } catch {
    return { ok: false, message: 'repo does not exist' }
  }

  const homes = home === undefined ? [] : [home, fs.realpathSync(home)]

  if (real === sep || homes.some(h => inside(h, real))) {
    return { ok: false, message: 'repo is the filesystem root, the home directory or one of its parents' }
  }

  const protectedRoots = forbidden.flatMap(path => {
    try {
      return [path, fs.realpathSync(path)]
    } catch {
      return [path]
    }
  })

  if (protectedRoots.some(root => inside(real, root) || inside(root, real))) {
    return { ok: false, message: 'repo contains or is inside a directory crew protects' }
  }

  // Codex loads a project's `.codex/config.toml`, and an MCP server it names runs as the user, outside the sandbox: a
  // repository that carries one, or sits under a directory that does (up to the home), is refused.
  for (let dir = real; dir !== sep && dir !== dirname(dir) && !homes.includes(dir); dir = dirname(dir)) {
    if (fs.existsSync(join(dir, '.codex', 'config.toml'))) {
      return { ok: false, message: `${join(dir, '.codex', 'config.toml')} would be loaded by Codex and can run programs outside the sandbox: remove it or work elsewhere` }
    }
  }

  const lane = laneOf(role)

  if (lane.dir === '') {
    return { ok: true, cwd: real }
  }

  const target = join(real, lane.dir)

  try {
    let found

    try {
      found = fs.lstatSync(target)
    } catch {
      fs.mkdirSync(target, { mode: 0o700 })
      found = fs.lstatSync(target)
    }

    if (found.isSymbolicLink() || !found.isDirectory()) {
      return { ok: false, message: `${lane.dir} is a link or not a directory` }
    }

    if (fs.realpathSync(target) !== target) {
      return { ok: false, message: `${lane.dir} does not resolve inside the repository` }
    }
  } catch {
    return { ok: false, message: `${lane.dir} cannot be used` }
  }

  return { ok: true, cwd: target }
}
