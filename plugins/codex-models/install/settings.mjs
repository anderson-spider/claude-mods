// What install.sh and uninstall.sh change in ~/.claude/settings.json, as pure functions over parsed JSON: no file,
// network or clock access here (install/cli.mjs does the I/O), so tests run them on plain values.
//
// Install adds exactly: env.ANTHROPIC_BASE_URL, one `X-Ccmproxy-Token: <secret>` line in env.ANTHROPIC_CUSTOM_HEADERS,
// env.ENABLE_TOOL_SEARCH=true, and modelPicker.options rows whose description ends with MARK.

export const HEADER = 'X-Ccmproxy-Token'
export const MARK = '(codex-models)'

const LOOPBACK = /^http:\/\/(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|localhost)(:\d{1,5})?\/?$/

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const clone = value => JSON.parse(JSON.stringify(value))
const trimSlash = url => url.replace(/\/+$/, '')

/** Whether `url` is a plain-http URL on a literal loopback address (or localhost) with no path. */
export function isLoopbackHttp(url) {
  return typeof url === 'string' && LOOPBACK.test(url)
}

const sameUrl = (a, b) => typeof a === 'string' && typeof b === 'string' && trimSlash(a) === trimSlash(b)

/** Whether one `Name: value` line of ANTHROPIC_CUSTOM_HEADERS is the proxy's secret header. */
export function isOurHeader(line) {
  const colon = line.indexOf(':')
  return colon > 0 && line.slice(0, colon).trim().toLowerCase() === HEADER.toLowerCase()
}

const headerLines = value => (value === '' ? [] : value.split(/\r?\n/))

/** Headers without the proxy's line, the other lines exactly as they were (a trailing empty line dropped). */
function withoutOurHeader(value) {
  const lines = headerLines(value).filter(line => !isOurHeader(line))
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

export function isMarked(row) {
  return isObject(row) && typeof row.description === 'string' && row.description.endsWith(MARK)
}

const marked = description => (typeof description === 'string' && description.trim() !== '' ? `${description.trim()} ${MARK}` : MARK)

/**
 * The `/model` rows for `models --json` output: `{ id, label, description, behavesAs? }` each, ids non-empty and
 * unique; `behavesAs` (the Claude model id Claude Code detects features from) is kept when it is a non-empty string.
 */
export function pickerRows(models) {
  if (!Array.isArray(models)) return { error: 'the model list is not a JSON array' }
  const rows = []
  const seen = new Set()
  for (const model of models) {
    if (!isObject(model) || typeof model.id !== 'string' || model.id.trim() === '') {
      return { error: 'a model in the list has no id' }
    }
    if (seen.has(model.id)) continue
    seen.add(model.id)
    const label = typeof model.label === 'string' && model.label.trim() !== '' ? model.label : model.id
    const behavesAs = typeof model.behavesAs === 'string' && model.behavesAs.trim() !== '' ? { behavesAs: model.behavesAs } : {}
    rows.push({ model: model.id, label, description: marked(model.description), ...behavesAs })
  }
  return { rows }
}

/** Checks `ccmproxy env --shell json` output: the three variables, the base URL on loopback, the header one line. */
export function checkEnv(env) {
  if (!isObject(env)) return 'the proxy environment is not a JSON object'
  if (!isLoopbackHttp(env.ANTHROPIC_BASE_URL)) return 'the proxy base URL is not a loopback http URL'
  const header = env.ANTHROPIC_CUSTOM_HEADERS
  if (typeof header !== 'string' || /[\r\n]/.test(header) || !isOurHeader(header) || header.split(':').slice(1).join(':').trim() === '') {
    return `the proxy environment has no single ${HEADER} header line`
  }
  if (env.ENABLE_TOOL_SEARCH !== 'true') return 'the proxy environment does not turn tool search on'
  return undefined
}

/** Refuses malformed containers before either install or uninstall changes anything. */
function containerRefusal(settings) {
  if (!isObject(settings)) return 'settings.json does not hold a JSON object'
  if ('env' in settings && !isObject(settings.env)) return 'settings.json has an "env" that is not an object'
  if ('modelPicker' in settings && !isObject(settings.modelPicker)) return 'settings.json has a "modelPicker" that is not an object'
  if (isObject(settings.modelPicker) && 'options' in settings.modelPicker && !Array.isArray(settings.modelPicker.options)) {
    return 'settings.json has a "modelPicker.options" that is not an array'
  }
  const headers = settings.env?.ANTHROPIC_CUSTOM_HEADERS
  if (headers !== undefined && typeof headers !== 'string') return 'settings.json has an env.ANTHROPIC_CUSTOM_HEADERS that is not a string'
  return undefined
}

/** Install accepts no base URL or only the current configured proxy URL. */
export function settingsRefusal(settings, proxyUrl) {
  const malformed = containerRefusal(settings)
  if (malformed) return malformed
  const current = settings.env?.ANTHROPIC_BASE_URL
  if (current !== undefined && !sameUrl(current, proxyUrl)) {
    return 'env.ANTHROPIC_BASE_URL is already set to a different URL; uninstall first, then reinstall'
  }
  return undefined
}

/** The settings after install; unrelated keys, header lines and unmarked picker rows stay. */
export function planInstall(settings, env, models) {
  const envError = checkEnv(env)
  if (envError) return { error: envError }
  const picked = pickerRows(models)
  if (picked.error) return { error: picked.error }
  const refusal = settingsRefusal(settings, env.ANTHROPIC_BASE_URL)
  if (refusal) return { error: refusal }

  const next = clone(settings)
  const headers = next.env?.ANTHROPIC_CUSTOM_HEADERS
  next.env = next.env ?? {}
  next.env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL
  next.env.ANTHROPIC_CUSTOM_HEADERS = [...withoutOurHeader(headers ?? ''), env.ANTHROPIC_CUSTOM_HEADERS].join('\n')
  next.env.ENABLE_TOOL_SEARCH = 'true'

  next.modelPicker = next.modelPicker ?? {}
  const kept = (next.modelPicker.options ?? []).filter(row => !isMarked(row))
  // A row the person added for the same id is theirs: it stays, and no marked twin is added beside it.
  const theirs = new Set(kept.filter(isObject).map(row => row.model))
  next.modelPicker.options = [...kept, ...picked.rows.filter(row => !theirs.has(row.model))]
  return { settings: next }
}

/** Remove the current owned entries; no earlier values are restored. */
export function planUninstall(settings) {
  const refusal = containerRefusal(settings)
  if (refusal) return { error: refusal }
  const next = clone(settings)
  if (next.env) {
    const env = next.env
    const headers = env.ANTHROPIC_CUSTOM_HEADERS
    const hadOurHeader = typeof headers === 'string' && headerLines(headers).some(isOurHeader)
    if (isLoopbackHttp(env.ANTHROPIC_BASE_URL) && hadOurHeader) delete env.ANTHROPIC_BASE_URL
    if (headers !== undefined) {
      const rest = withoutOurHeader(headers)
      if (rest.length === 0) delete env.ANTHROPIC_CUSTOM_HEADERS
      else env.ANTHROPIC_CUSTOM_HEADERS = rest.join('\n')
    }
    delete env.ENABLE_TOOL_SEARCH
    if (Object.keys(env).length === 0) delete next.env
  }
  if (next.modelPicker) {
    const picker = next.modelPicker
    if (picker.options) {
      picker.options = picker.options.filter(row => !isMarked(row))
      if (picker.options.length === 0) delete picker.options
    }
    if (Object.keys(picker).length === 0) delete next.modelPicker
  }
  return { settings: next }
}

/**
 * What `GET /__ccmproxy/status` answered, sent with the secret: `ok` only for a 200 whose JSON names the service
 * `ccmproxy`; a 403 in ccmproxy's own error shape is `forbidden` (the secret) or `host` (the Host header); anything
 * else, another 403 included, is `foreign`, with a short reason that carries no body.
 */
export function readStatusReply(status, text) {
  if (status === 403) return refusalOf(text)
  if (status !== 200) return { kind: 'foreign', reason: `HTTP ${status}` }
  let body
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
    models: Array.isArray(body.models) ? body.models.filter(id => typeof id === 'string') : [],
  }
}

/** A 403 from ccmproxy: `{"type":"error","error":{"type":"permission_error","message":"ccmproxy: ..."}}`. */
function refusalOf(text) {
  let body
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

/** The settings with the value of every X-Ccmproxy-Token header line replaced, for anything printed. */
export function maskedSettings(settings) {
  if (!isObject(settings) || !isObject(settings.env) || typeof settings.env.ANTHROPIC_CUSTOM_HEADERS !== 'string') return settings
  const next = clone(settings)
  next.env.ANTHROPIC_CUSTOM_HEADERS = headerLines(next.env.ANTHROPIC_CUSTOM_HEADERS)
    .map(line => (isOurHeader(line) ? `${line.slice(0, line.indexOf(':'))}: <secret>` : line))
    .join('\n')
  return next
}

/** `text` with every occurrence of `secret` replaced, for anything printed. */
export function masked(text, secret) {
  return secret ? text.split(secret).join('<secret>') : text
}

/** The secret in a `X-Ccmproxy-Token: <secret>` line. */
export function secretOf(headerLine) {
  return headerLine.slice(headerLine.indexOf(':') + 1).trim()
}
