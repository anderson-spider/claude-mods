// Reading the proxy's state and the user's settings, and the words for it. Pure: the network and the timer are
// injected (`ProbeIo`), and the texts take plain values. Nothing here ever holds or prints a secret beyond the
// header it is sent in.

/** The proxy's secret header; install/settings.mjs names it too (tests/status.test.ts checks they agree). */
export const HEADER = 'X-Ccmproxy-Token'
/** The suffix that marks a `/model` row install.sh added. */
export const MARK = '(codex-models)'
/** How long `session.start` waits for the status answer: inside the hook's budget, short enough not to stall a start. */
export const DEADLINE_MS = 1500
export const STATUS_PATH = '/__ccmproxy/status'
export const LABEL = 'com.anderson-spider.codex-models'
export const TARGET = '~/.claude/codex-models'
export const UNINSTALL = `${TARGET}/uninstall.sh`

type Json = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const LOOPBACK = /^http:\/\/(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|localhost)(:\d{1,5})?\/?$/

/** The base URL without its trailing slash when it is plain http on a loopback address with no path; else undefined. */
export function loopbackBase(url: unknown): string | undefined {
  return typeof url === 'string' && LOOPBACK.test(url) ? url.replace(/\/+$/, '') : undefined
}

export function isOurHeader(line: string): boolean {
  const colon = line.indexOf(':')
  return colon > 0 && line.slice(0, colon).trim().toLowerCase() === HEADER.toLowerCase()
}

/** The secret from ANTHROPIC_CUSTOM_HEADERS (newline-separated `Name: value` lines), if one is there. */
export function tokenOf(headers: unknown): string | undefined {
  if (typeof headers !== 'string') return undefined
  const line = headers.split(/\r?\n/).find(isOurHeader)
  const token = line?.slice(line.indexOf(':') + 1).trim()
  return token ? token : undefined
}

/** The proxy URL and secret from ccmproxy's config.json text; a field that is missing or malformed is left out. */
export function configOf(text: string): { base?: string; token?: string } {
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isObject(config)) return {}
  const base = typeof config.listen_http === 'string' ? loopbackBase(`http://${config.listen_http}`) : undefined
  const token = typeof config.auth_token === 'string' && config.auth_token !== '' ? config.auth_token : undefined
  return { ...(base ? { base } : {}), ...(token ? { token } : {}) }
}

export function versionOf(pluginJson: string): string {
  try {
    const version = (JSON.parse(pluginJson) as { version?: unknown }).version
    return typeof version === 'string' ? version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** What the status check found. */
export type Probe =
  | { kind: 'ok'; version: string; codexLogin: boolean; models: string[] }
  | { kind: 'forbidden' }
  | { kind: 'host' }
  | { kind: 'foreign'; reason: string }
  | { kind: 'down' }
  | { kind: 'timeout' }
  | { kind: 'no-secret' }

/**
 * The status answer: `ok` only for a 200 whose JSON names `ccmproxy`; a 403 in ccmproxy's own error shape is
 * `forbidden` (the secret) or `host` (the Host header), any other 403 `foreign`. A reason never quotes the body.
 */
export function readReply(status: number, text: string): Probe {
  if (status === 403) return refusalOf(text)
  if (status !== 200) return { kind: 'foreign', reason: `HTTP ${status}` }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { kind: 'foreign', reason: 'the answer is not JSON' }
  }
  if (!isObject(body) || body.service !== 'ccmproxy') return { kind: 'foreign', reason: 'the answer does not name ccmproxy' }
  return {
    kind: 'ok',
    version: typeof body.version === 'string' ? body.version : '',
    codexLogin: body.codexLogin === true,
    models: Array.isArray(body.models) ? body.models.filter((id): id is string => typeof id === 'string') : [],
  }
}

/** A 403 from ccmproxy: `{"type":"error","error":{"type":"permission_error","message":"ccmproxy: ..."}}`. */
function refusalOf(text: string): Probe {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { kind: 'foreign', reason: 'HTTP 403 not from ccmproxy' }
  }
  const error = isObject(body) && body.type === 'error' && isObject(body.error) ? body.error : undefined
  const message = error?.type === 'permission_error' && typeof error.message === 'string' ? error.message : ''
  if (!message.startsWith('ccmproxy:')) return { kind: 'foreign', reason: 'HTTP 403 not from ccmproxy' }
  return message.includes('unexpected Host header') ? { kind: 'host' } : { kind: 'forbidden' }
}

export type ProbeIo = {
  fetch: (url: string, headers: Record<string, string>) => Promise<{ status: number; text: string }>
  /** Calls `fn` after `ms`; the function returned cancels it. */
  timer: (ms: number, fn: () => void) => () => void
}

/** One status request with the secret, settled by its answer, its failure or the deadline, whichever comes first. */
export function probe(io: ProbeIo, base: string, token: string | undefined, ms = DEADLINE_MS): Promise<Probe> {
  if (!token) return Promise.resolve({ kind: 'no-secret' })
  return new Promise(resolve => {
    let isDone = false
    let cancel = () => {}
    const finish = (result: Probe) => {
      if (isDone) return
      isDone = true
      cancel()
      resolve(result)
    }
    cancel = io.timer(ms, () => finish({ kind: 'timeout' }))
    // A fetch that cannot be aborted settles later into nothing: `finish` runs once.
    io.fetch(`${base}${STATUS_PATH}`, { [HEADER]: token }).then(
      reply => finish(readReply(reply.status, reply.text)),
      () => finish({ kind: 'down' }),
    )
  })
}

export type Context = { base: string; pluginVersion: string; pluginRoot: string }

const restart = `launchctl kickstart -k gui/$(id -u)/${LABEL}`
const reinstall = (root: string) => `sh ${root}/install.sh`
const wayBack = `or go back to Anthropic directly with ${UNINSTALL} and restart Claude Code`

/** The problem with the proxy, in one line with the way out, or undefined when there is none. */
export function problemText(found: Probe, c: Context): string | undefined {
  switch (found.kind) {
    case 'down':
      return `the proxy at ${c.base} is down, so this session's requests fail. Start it with ${restart}, ${wayBack}.`
    case 'timeout':
      return `the proxy at ${c.base} did not answer within ${DEADLINE_MS / 1000} s, so this session's requests may fail. Restart it with ${restart}, ${wayBack}.`
    case 'forbidden':
      return `the proxy at ${c.base} refused this session's secret (403): the ${HEADER} header in ~/.claude/settings.json does not match its config. Write it again with ${reinstall(c.pluginRoot)}, ${wayBack}.`
    case 'host':
      return `the proxy at ${c.base} refused the Host header (403): it listens on another address than ANTHROPIC_BASE_URL names. Write it again with ${reinstall(c.pluginRoot)}, ${wayBack}.`
    case 'foreign':
      return `something other than ccmproxy answers at ${c.base} (${found.reason}), and this session's requests, with your login, go to it. Run ${UNINSTALL} and restart Claude Code.`
    case 'no-secret':
      return `ANTHROPIC_BASE_URL points at ${c.base} but no ${HEADER} header is set, so the proxy refuses every request. Add it with ${reinstall(c.pluginRoot)}, ${wayBack}.`
    case 'ok':
      if (found.version !== c.pluginVersion) {
        return `the proxy runs ${found.version || 'an unknown version'} and the plugin is ${c.pluginVersion}: rebuild it with ${reinstall(c.pluginRoot)}.`
      }
      if (!found.codexLogin) {
        return `the proxy's Codex remote has no active Codex account or is not configured, so Codex models fail. Set CLIPROXY_URL and CLIPROXY_MGMT_KEY, then run ${reinstall(c.pluginRoot)}.`
      }
      return undefined
  }
}

/** The `session.start` notice, or undefined when the proxy is this install's, current and its remote has an account. */
export function noticeText(found: Probe, c: Context): string | undefined {
  const problem = problemText(found, c)
  return problem ? `codex-models: ${problem}` : undefined
}

/** What install.sh left in the user's settings, read without the secret. */
export type SettingsView = { baseUrl?: string; token?: string; toolSearch?: string; rows: string[] }

export function settingsView(user: Json): SettingsView {
  const env = isObject(user.env) ? user.env : {}
  const picker = isObject(user.modelPicker) ? user.modelPicker : {}
  const options = Array.isArray(picker.options) ? picker.options : []
  const rows = options
    .filter((row): row is Json => isObject(row) && typeof row.description === 'string' && row.description.endsWith(MARK))
    .map(row => String(row.model))
  const token = tokenOf(env.ANTHROPIC_CUSTOM_HEADERS)
  return {
    ...(typeof env.ANTHROPIC_BASE_URL === 'string' ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}),
    ...(token ? { token } : {}),
    ...(typeof env.ENABLE_TOOL_SEARCH === 'string' ? { toolSearch: env.ENABLE_TOOL_SEARCH } : {}),
    rows,
  }
}

export type Report = {
  pluginVersion: string
  pluginRoot: string
  /** The proxy URL checked: the session's base URL when it is on loopback, else the config's. */
  base?: string
  probe?: Probe
  /** The secret in ccmproxy's config, to compare with the header in the settings; never printed. */
  configToken?: string
  settings?: SettingsView
}

const probeLine = (found: Probe, base: string, pluginVersion: string): string => {
  switch (found.kind) {
    case 'ok': {
      const drift = found.version === pluginVersion ? 'matches the plugin' : `the plugin is ${pluginVersion}`
      return `Proxy: ccmproxy ${found.version || '(no version)'} at ${base} (${drift})`
    }
    case 'down':
      return `Proxy: down at ${base}`
    case 'timeout':
      return `Proxy: no answer at ${base} within ${DEADLINE_MS / 1000} s`
    case 'forbidden':
      return `Proxy: ${base} refused the secret (403)`
    case 'host':
      return `Proxy: ${base} refused the Host header (403)`
    case 'foreign':
      return `Proxy: ${base} is not ccmproxy (${found.reason})`
    case 'no-secret':
      return `Proxy: not checked, no ${HEADER} secret in the environment or the config`
  }
}

/** The `/codex-models:status` answer. */
export function reportText(r: Report): string {
  const lines = [`codex-models ${r.pluginVersion}`]
  if (!r.base || !r.probe) {
    lines.push(`Proxy: not installed (no loopback ANTHROPIC_BASE_URL and no config in ${TARGET}/home); run ${reinstall(r.pluginRoot)}`)
  } else {
    lines.push(probeLine(r.probe, r.base, r.pluginVersion))
    if (r.probe.kind === 'ok') {
      lines.push(`Codex remote account: ${r.probe.codexLogin ? 'found' : `not found; set CLIPROXY_URL and CLIPROXY_MGMT_KEY, then run ${reinstall(r.pluginRoot)}`}`)
      lines.push(`Models: ${r.probe.models.length > 0 ? r.probe.models.join(', ') : 'none'}`)
    }
  }

  const s = r.settings
  if (!s) {
    lines.push('Settings: ~/.claude/settings.json could not be read')
  } else {
    const header = !s.token
      ? 'missing'
      : !r.configToken
        ? 'present (secret not shown)'
        : s.token === r.configToken
          ? 'present, matches the proxy config (secret not shown)'
          : 'present, differs from the proxy config (secret not shown)'
    const baseNote = s.baseUrl && r.base && loopbackBase(s.baseUrl) !== r.base ? ` (the proxy checked is ${r.base})` : ''
    lines.push(
      'Settings (~/.claude/settings.json):',
      `  ANTHROPIC_BASE_URL: ${s.baseUrl ?? 'not set'}${baseNote}`,
      `  ${HEADER} header: ${header}`,
      `  ENABLE_TOOL_SEARCH: ${s.toolSearch ?? 'not set'}`,
      `  /model rows: ${s.rows.length > 0 ? `${s.rows.length} (${s.rows.join(', ')})` : 'none'}`,
    )
  }

  const problem = r.base && r.probe ? problemText(r.probe, { base: r.base, pluginVersion: r.pluginVersion, pluginRoot: r.pluginRoot }) : undefined
  if (problem) lines.push(`Next: ${problem}`)
  return lines.join('\n')
}
