// Finds the newest installed Codex computer-use configuration and turns its
// `mcpServers.cua_repl` entry into a launchable command. Pure apart from the
// directory reads in `newestConfig`; nothing here prints the configuration.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CONFIG_ROOT = join(homedir(), '.codex/plugins/cache/openai-bundled/unified-computer-use')
export const SERVER_KEY = 'cua_repl'
// The browser surface needs Codex turn metadata (session_id, turn_id) that only the
// Codex app sends; Claude keeps its own browser tools, so only the desktop is enabled.
export const SURFACES = 'computer'

/** Numeric, segment by segment: `26.930.61225` > `26.92.99999`. */
export const compareVersions = (a, b) => {
  const left = a.split(/[.-]/)
  const right = b.split(/[.-]/)

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? '0'
    const y = right[i] ?? '0'
    const nx = Number(x)
    const ny = Number(y)
    const diff = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y)

    if (diff !== 0) {
      return diff < 0 ? -1 : 1
    }
  }

  return 0
}

/** The newest version name among `names`, or undefined. */
export const pickNewest = names => [...names].sort(compareVersions).at(-1)

/** Reads `<root>/<newest>/.mcp.json` and returns its `cua_repl` server; throws a plain error naming the missing piece. */
export const newestConfig = (root = CONFIG_ROOT) => {
  if (!existsSync(root)) {
    throw new Error(
      `Codex computer use is not installed: ${root} does not exist. Install the ChatGPT desktop app and turn on Computer Use in Codex once.`,
    )
  }

  const versions = readdirSync(root).filter(name => existsSync(join(root, name, '.mcp.json')))
  const version = pickNewest(versions)

  if (version === undefined) {
    throw new Error(`No version folder under ${root} has a .mcp.json.`)
  }

  const path = join(root, version, '.mcp.json')
  const server = JSON.parse(readFileSync(path, 'utf8'))?.mcpServers?.[SERVER_KEY]

  if (server === undefined || typeof server.command !== 'string') {
    throw new Error(`${path} has no mcpServers.${SERVER_KEY} with a command.`)
  }

  if (server.enabled === false) {
    throw new Error(`mcpServers.${SERVER_KEY} is disabled in ${path}.`)
  }

  return {
    version,
    path,
    command: server.command,
    args: Array.isArray(server.args) ? server.args.map(String) : [],
    env: server.env !== null && typeof server.env === 'object' ? server.env : {},
  }
}

/** The child's environment: ours, then the configuration's, with only the desktop surface on. */
export const serverEnv = (base, config) => ({ ...base, ...config.env, CUA_REPL_ENABLED_SURFACES: SURFACES })

const isExecutable = path => {
  try {
    return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** What `launch.mjs --check` prints: versions, paths and env keys, never env values. */
export const check = (root = CONFIG_ROOT) => {
  const config = newestConfig(root)
  const service = config.env.SKY_CUA_SERVICE_PATH
  const problems = []

  if (!isExecutable(config.command)) {
    problems.push(`runtime not found or not executable: ${config.command}`)
  }

  for (const arg of config.args.filter(arg => arg.startsWith('/'))) {
    if (!existsSync(arg)) {
      problems.push(`launcher argument not found: ${arg}`)
    }
  }

  const repl = config.env.CUA_REPL_NODE_REPL_PATH

  if (typeof repl === 'string' && !isExecutable(repl)) {
    problems.push(`node_repl not found: ${repl}`)
  }

  if (typeof service === 'string' && !existsSync(service)) {
    problems.push(`Codex Computer Use service app not found: ${service}`)
  }

  return {
    ok: problems.length === 0,
    version: config.version,
    config: config.path,
    command: config.command,
    args: config.args,
    envKeys: Object.keys(config.env).sort(),
    surfaces: SURFACES,
    problems,
  }
}
