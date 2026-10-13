// Where the `codex` binary and the isolated Codex home are. A launchd job has no user PATH, so the binary is found by
// absolute candidates; the home holds only a link to the user's login, so none of the user's MCP servers, hooks or
// plugins load into a crew thread, and the login stays the Codex CLI's file: crew never writes it.
import { existsSync, readdirSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'

/** Global flags that keep the user's apps, plugins, hooks and desktop tools out of a crew thread. */
export const DISABLED = ['apps', 'plugins', 'hooks', 'computer_use', 'browser_use']

const executable = path => {
  try {
    accessSync(path, constants.X_OK)

    return true
  } catch {
    return false
  }
}

/** Newest first: the standalone releases the Codex CLI keeps under `~/.codex`, then the usual link locations. */
export const candidates = (home, list = readdirSync) => {
  const releases = join(home, '.codex/packages/standalone/releases')
  let names = []

  try {
    names = list(releases).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  } catch {}

  return [
    join(home, '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    ...names.map(name => join(releases, name, 'bin/codex')),
  ]
}

/** The first executable candidate, or undefined. */
export const findCodex = (home, { list = readdirSync, can = executable } = {}) => candidates(home, list).find(can)

/** Makes `<dir>` with only `auth.json`, a link to `<home>/.codex/auth.json`; answers whether the login file exists. */
export const prepareHome = (dir, home) => {
  const login = join(home, '.codex/auth.json')

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const link = join(dir, 'auth.json')

  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === login) {
      return existsSync(login)
    }

    unlinkSync(link)
  } catch {}

  symlinkSync(login, link)

  return existsSync(login)
}

/** argv for `codex`: the global disables, then the server. */
export const serverArgs = () => [...DISABLED.flatMap(name => ['--disable', name]), 'app-server']
