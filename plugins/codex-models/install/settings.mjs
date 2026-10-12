// What install.sh and uninstall.sh change in ~/.claude/settings.json, as pure functions over parsed JSON: no file,
// network or clock access here (install/cli.mjs does the I/O), so tests run them on plain values.
//
// Install adds exactly: env.ANTHROPIC_BASE_URL, one `X-Ccmproxy-Token: <secret>` line in env.ANTHROPIC_CUSTOM_HEADERS,
// env.ENABLE_TOOL_SEARCH=true, and modelPicker.options rows whose description ends with MARK. The state it returns
// records what stood there before, without any header value, so uninstall can take back only those.

export const HEADER = 'X-Ccmproxy-Token'
export const MARK = '(codex-models)'
export const STATE_VERSION = 1

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

/** The `/model` rows for `models --json` output: `{ id, label, description }` each, ids non-empty and unique. */
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
    rows.push({ model: model.id, label, description: marked(model.description) })
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

/** Whether `prior` is a state of this format whose base URL the settings still hold. */
const keepsPriorOf = (settings, prior) =>
  isObject(prior) && prior.v === STATE_VERSION && isObject(settings.env) && sameUrl(settings.env.ANTHROPIC_BASE_URL, prior.baseUrl)

/**
 * Why install would refuse these settings, or undefined. `baseUrl` is the proxy's, or undefined before a config
 * exists (then any base URL already set that `prior` does not account for is someone else's). install.sh asks this
 * before it builds or loads anything, and planInstall asks it again with the real base URL.
 */
export function settingsRefusal(settings, baseUrl, prior) {
  if (!isObject(settings)) return 'settings.json does not hold a JSON object'
  if ('env' in settings && !isObject(settings.env)) return 'settings.json has an "env" that is not an object'
  if ('modelPicker' in settings && !isObject(settings.modelPicker)) return 'settings.json has a "modelPicker" that is not an object'
  if (isObject(settings.modelPicker) && 'options' in settings.modelPicker && !Array.isArray(settings.modelPicker.options)) {
    return 'settings.json has a "modelPicker.options" that is not an array'
  }
  const current = settings.env?.ANTHROPIC_BASE_URL
  if (current !== undefined && !sameUrl(current, baseUrl) && !keepsPriorOf(settings, prior)) {
    return (
      `env.ANTHROPIC_BASE_URL is already ${JSON.stringify(current)}; install leaves it alone because uninstall could ` +
      'not restore it. Remove it from settings.json first, or run with --no-settings.'
    )
  }
  const headers = settings.env?.ANTHROPIC_CUSTOM_HEADERS
  if (headers !== undefined && typeof headers !== 'string') return 'settings.json has an env.ANTHROPIC_CUSTOM_HEADERS that is not a string'
  return undefined
}

/**
 * The settings after install, and the state uninstall reads. `prior` is the state a previous install left; it is
 * kept while the settings still hold its base URL, so a second run neither changes the result nor forgets what
 * stood there before the first. `fileExisted` false means settings.json was not there: uninstall then removes it
 * when nothing else is left in it.
 */
export function planInstall(settings, env, models, prior, fileExisted = true) {
  const envError = checkEnv(env)
  if (envError) return { error: envError }
  const picked = pickerRows(models)
  if (picked.error) return { error: picked.error }
  const refusal = settingsRefusal(settings, env.ANTHROPIC_BASE_URL, prior)
  if (refusal) return { error: refusal }

  const next = clone(settings)
  const keepsPrior = keepsPriorOf(settings, prior)
  const headers = next.env?.ANTHROPIC_CUSTOM_HEADERS

  const state = keepsPrior
    ? { ...prior, baseUrl: env.ANTHROPIC_BASE_URL }
    : {
        v: STATE_VERSION,
        baseUrl: env.ANTHROPIC_BASE_URL,
        envCreated: !('env' in next),
        headersExisted: headers !== undefined,
        toolSearch: next.env && 'ENABLE_TOOL_SEARCH' in next.env ? { present: true, value: next.env.ENABLE_TOOL_SEARCH } : { present: false },
        pickerCreated: !('modelPicker' in next),
        optionsCreated: !isObject(next.modelPicker) || !('options' in next.modelPicker),
        fileCreated: !fileExisted,
      }

  next.env = next.env ?? {}
  next.env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL
  next.env.ANTHROPIC_CUSTOM_HEADERS = [...withoutOurHeader(headers ?? ''), env.ANTHROPIC_CUSTOM_HEADERS].join('\n')
  next.env.ENABLE_TOOL_SEARCH = 'true'

  next.modelPicker = next.modelPicker ?? {}
  const kept = (next.modelPicker.options ?? []).filter(row => !isMarked(row))
  // A row the person added for the same id is theirs: it stays, and no marked twin is added beside it.
  const theirs = new Set(kept.filter(isObject).map(row => row.model))
  const added = picked.rows.filter(row => !theirs.has(row.model))
  next.modelPicker.options = [...kept, ...added]
  state.models = added.map(row => row.model)

  return { settings: next, state }
}

/**
 * The settings after uninstall: what install added taken out, what it replaced put back. `state` may be missing.
 * `remove` is true when install created the file and nothing else was added to it since.
 */
export function planUninstall(settings, state) {
  if (!isObject(settings)) return { error: 'settings.json does not hold a JSON object' }
  const known = isObject(state) && state.v === STATE_VERSION ? state : undefined
  const next = clone(settings)

  if (isObject(next.env)) {
    const env = next.env
    const headers = typeof env.ANTHROPIC_CUSTOM_HEADERS === 'string' ? env.ANTHROPIC_CUSTOM_HEADERS : undefined
    const hadOurHeader = headers !== undefined && headerLines(headers).some(isOurHeader)
    // Without a state, the base URL is ours only when it is on loopback and our header rides with it.
    const ourBase = known ? sameUrl(env.ANTHROPIC_BASE_URL, known.baseUrl) : isLoopbackHttp(env.ANTHROPIC_BASE_URL) && hadOurHeader
    if (ourBase) delete env.ANTHROPIC_BASE_URL

    if (headers !== undefined && hadOurHeader) {
      const rest = withoutOurHeader(headers)
      if (rest.length === 0 && !(known?.headersExisted ?? false)) delete env.ANTHROPIC_CUSTOM_HEADERS
      else env.ANTHROPIC_CUSTOM_HEADERS = rest.join('\n')
    }

    // Without a state, tool search stays: it is harmless, and it may have been there before.
    if (known && env.ENABLE_TOOL_SEARCH === 'true') {
      if (known.toolSearch?.present) env.ENABLE_TOOL_SEARCH = known.toolSearch.value
      else delete env.ENABLE_TOOL_SEARCH
    }

    if (known?.envCreated && Object.keys(env).length === 0) delete next.env
  }

  if (isObject(next.modelPicker) && Array.isArray(next.modelPicker.options)) {
    const picker = next.modelPicker
    picker.options = picker.options.filter(row => !isMarked(row))
    if (picker.options.length === 0 && known?.optionsCreated) delete picker.options
    if (Object.keys(picker).length === 0 && known?.pickerCreated) delete next.modelPicker
  }

  return { settings: next, remove: known?.fileCreated === true && Object.keys(next).length === 0 }
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

/** `text` with every occurrence of `secret` replaced, for anything printed. */
export function masked(text, secret) {
  return secret ? text.split(secret).join('<secret>') : text
}

/** The secret in a `X-Ccmproxy-Token: <secret>` line. */
export function secretOf(headerLine) {
  return headerLine.slice(headerLine.indexOf(':') + 1).trim()
}
