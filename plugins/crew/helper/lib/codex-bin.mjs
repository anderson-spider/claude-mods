// Where the `codex` binary and the isolated Codex home are. A launchd job has no user PATH, so the binary is found by
// absolute candidates; the home holds only a link to the user's login, so none of the user's MCP servers, hooks or
// plugins load into a crew thread (the one exception is the fixed `MCP_SERVERS` table below), and the login stays the
// Codex CLI's file: crew never writes it.
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

  if (lstatSync(dir).isSymbolicLink()) {
    throw new Error(`${dir} is a link: the isolated Codex home must be a real directory`)
  }

  const link = join(dir, 'auth.json')
  let current

  try {
    current = lstatSync(link)
  } catch {}

  // Only a link is ours to replace; a file or directory there is somebody's, and is left for a person to remove.
  if (current !== undefined && !current.isSymbolicLink()) {
    throw new Error(`${link} is not a link to the Codex login: remove it by hand`)
  }

  if (current === undefined || readlinkSync(link) !== login) {
    if (current !== undefined) {
      unlinkSync(link)
    }

    symlinkSync(login, link)
  }

  return existsSync(login)
}

/**
 * The only MCP servers a crew thread gets, declared here and never read from the user's config. `url` is a remote server
 * (anonymous: the user's OAuth credentials are not in the isolated home); `command` is a program looked up by `binCandidates`,
 * because a launchd job has no user PATH. A server whose program is not found is left out.
 */
export const MCP_SERVERS = Object.freeze([
  Object.freeze({ name: 'context7', url: 'https://mcp.context7.com/mcp' }),
  Object.freeze({ name: 'codegraph', command: 'codegraph', args: Object.freeze(['serve', '--mcp']) }),
])

/** Where a server program may be: the usual link locations, like `candidates`. */
export const binCandidates = (home, name) => [join(home, '.local/bin', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]

/** `MCP_SERVERS` with each `command` resolved to an absolute path; a server with no executable program is dropped. */
export const mcpServers = (home, { can = executable } = {}) =>
  MCP_SERVERS.flatMap(server => {
    if (server.command === undefined) {
      return [server]
    }

    const command = binCandidates(home, server.command).find(can)

    return command === undefined ? [] : [{ ...server, command }]
  })

const toml = value => JSON.stringify(value)

/** The `-c` settings that declare one server. */
const mcpSettings = ({ name, url, command, args }) => [
  ...(url === undefined ? [] : [`mcp_servers.${name}.url=${toml(url)}`]),
  ...(command === undefined ? [] : [`mcp_servers.${name}.command=${toml(command)}`]),
  ...(args === undefined ? [] : [`mcp_servers.${name}.args=${toml(args)}`]),
]

/**
 * argv for `codex`: the global disables, the settings that keep a turn's shell lean and offline, the fixed MCP servers,
 * then the server.
 */
export const serverArgs = (servers = []) => [
  ...DISABLED.flatMap(name => ['--disable', name]),
  // Web search is not covered by networkAccess; a login shell would reload the user's profile (and its secrets).
  ...['web_search="disabled"', 'allow_login_shell=false', 'shell_environment_policy.inherit="core"', ...servers.flatMap(mcpSettings)].flatMap(
    setting => ['-c', setting],
  ),
  'app-server',
]

/** The environment the server gets: what a shell and Codex need, never the rest of the helper's. */
const ENV_KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM']

export const serverEnv = (env, home) => ({
  ...Object.fromEntries(Object.entries(env).filter(([key]) => ENV_KEEP.includes(key) || key.startsWith('LC_'))),
  CODEX_HOME: home,
})
