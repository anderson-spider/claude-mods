// Redaction for text that leaves the machine (decision 10): paths, secrets and email addresses.
// Pure and total: it never throws and the same input always gives the same output. Every pattern is linear on hostile
// input (bounded quantifiers, a boundary group instead of a scan from each position), because the text is agent output.
// Over-redaction is the safe side: a lost word costs the judge little, a leaked credential costs the person a lot.

export type RedactContext = {
  /** The person's home directory, e.g. `/Users/me`; becomes `~`. */
  home: string
  /** The repository (or worktree) root; paths under it become repo-relative. */
  root: string
}

export const REDACTED = '[redacted]'
export const PATH_PLACEHOLDER = '<path>'
export const EMAIL_PLACEHOLDER = '<email>'
const HOME_PATH = '~/<path>'
const ELLIPSIS = '…'

// A private key block, complete or cut off by truncation (then everything after the header goes).
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g

// Tokens recognizable by their own shape. None needs anything after the run, so the engine never backtracks.
const TOKEN_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic (sk-ant-), OpenRouter (sk-or-)
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35,}/g, // Google API key
  /\bnpm_[A-Za-z0-9]{36}/g,
  /\bya29\.[A-Za-z0-9_-]{10,}/g, // Google OAuth access token
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{0,2048}/g, // JWT
  // Webhook URLs are bearer secrets
  /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{1,200}/g,
  /https:\/\/(?:[a-z]{1,10}\.)?discord(?:app)?\.com\/api\/webhooks\/\d{1,30}\/[A-Za-z0-9_-]{1,200}/g,
]

// Names that are secret wherever they appear in an identifier (KEY covers apiKey and API_KEY_ID), and names that only
// count as a whole `_`, `-` or `.` segment (`db_pass` and `session_id`, but not `passed` or `author`).
const SUBSTRING_NAMES = 'KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|AUTHORIZATION|CONN(?:ECTION)?_?STRING'
const SEGMENT_NAMES = 'PASS|PWD|AUTH|DSN|SESSION'
const FLAG_NAMES = 'KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|COOKIE'
const HEADER_NAMES = 'x-api-key|api-key|x-auth-token|x-goog-api-key|cookie|set-cookie|proxy-authorization|authorization'
// Parameters that carry a credential under a name that does not say so (presigned URLs)
const PARAM_NAMES = 'x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|signature|sig'
const NAME = `(?:[\\w.-]{0,80}(?:${SUBSTRING_NAMES})[\\w.-]{0,80}|(?:[\\w.-]{0,40}[_.-])?(?:${SEGMENT_NAMES})(?:[_.-][\\w.-]{0,40})?)`

// A value: quoted, our own marker (so a second pass changes nothing), or a bare run.
const VALUE = '"[^"\\n]{0,2048}"|\'[^\'\\n]{0,2048}\'|\\[redacted\\]|[^\\s"\']{1,2048}'
// A quoted key's value also comes escaped (`\"abc\"`, as in a JSON string inside a log line or a test diff).
const QUOTED_VALUE = '\\\\"(?:[^\\\\\\n]|\\\\(?!")){0,2048}?\\\\"|"(?:[^"\\\\\\n]|\\\\.){0,2048}"|\'(?:[^\'\\\\\\n]|\\\\.){0,2048}\'|\\[redacted\\]|[^\\s,}\\]"\'\\\\]{1,2048}'

const QUOTED_KEY = new RegExp(`(\\\\?)(["'])(${NAME})\\1\\2(\\s*(?:=>|:=|<-|[:=])\\s*)(${QUOTED_VALUE})`, 'gi')
// `NAME: |` or `NAME:` with the secret on the indented lines under it
const YAML_BLOCK = new RegExp(`(^|[^\\w.-])(${NAME}[ \\t]*:[ \\t]*(?:[|>][-+0-9]{0,3})?[ \\t]*)(\\r?\\n(?:[ \\t]+[^\\r\\n]*(?:\\r?\\n|$)){1,64})`, 'gi')
// `Server=x;Password=P@ss word;`: after a `;` the value runs to the next `;` (or the line's end), spaces included
const CONNECTION_AFTER = new RegExp(`(;[ \\t]*)(${NAME}[ \\t]*=[ \\t]*)[^;\\r\\n"']{1,2048}`, 'gi')
const CONNECTION_FIRST = new RegExp(`(^|[\\r\\n])([ \\t]*${NAME}[ \\t]*=[ \\t]*)[^;\\r\\n"']{1,2048}(?=;)`, 'gi')
const ASSIGNED = new RegExp(`(^|[^\\w.-])(${NAME}[ \\t]*(?::=|<-|=(?!>)|:)[ \\t]*)(?:${VALUE})`, 'gi')
// `=>` only before a quoted value (Ruby, PHP): a bare `api_key => abc` stays on purpose, because `keys.map(key => key.id)` is code
const ROCKET = new RegExp(`(^|[^\\w.-])(${NAME}[ \\t]*=>[ \\t]*)(?:"[^"\\n]{0,2048}"|'[^'\\n]{0,2048}')`, 'gi')

/** Secrets and emails only (no paths): safe for text that has no home or root to translate, such as an error body. */
export function redactSecrets(text: string): string {
  let out = String(text)
  out = out.replace(PRIVATE_KEY, REDACTED)
  out = redactOrphanKeyEnds(out)
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED)
  // user:password@ and :password@ inside a URL. The userinfo runs to the LAST `@` before the host (the first `/` or the
  // end of the line), so a raw `@` or a space in the password leaks nothing. A port followed by prose is no userinfo:
  // `host:8080 text me@x.com`. The spaced form goes first; a password of digits is left to the second pattern.
  out = out.replace(/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@:]{0,200}:(?!\d+(?!\w))[^/\r\n]{1,400}@/gi, `$1${REDACTED}@`)
  out = out.replace(/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@:]{0,200}:[^\s/]{1,400}@/gi, `$1${REDACTED}@`)
  // A token as the whole userinfo (`https://<token>@host/x.git`): eight characters or more, right after `scheme://`, so a
  // short username (`ssh://git@host`), an `@` after a path, `mailto:` and scp-like `git@host:o/r` (no scheme) are untouched.
  out = out.replace(/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@:]{8,200}@/gi, `$1${REDACTED}@`)
  // Headers: the value is the rest of the line (a cookie holds spaces and semicolons), or up to the closing quote
  out = out.replace(
    new RegExp(`(^|[^\\w-])((?:${HEADER_NAMES})[ \\t]*[:=][ \\t]*)[^\\r\\n"']{1,4096}`, 'gi'),
    `$1$2${REDACTED}`,
  )
  // Bearer <token>: needs a digit or 20+ characters, so prose such as "bearer authentication" survives
  out = out.replace(
    /\bbearer\s+(?:(?=[A-Za-z0-9._~+/=-]{0,200}\d)[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{20,})/gi,
    `Bearer ${REDACTED}`,
  )
  // Basic <base64> with no header in front: needs a digit, `+`, `/` or `=`, so prose such as "Basic installation" survives
  out = out.replace(/\bbasic\s+(?=[A-Za-z0-9+/]{0,200}[0-9+/=])[A-Za-z0-9+/]{12,200}={0,2}/gi, `Basic ${REDACTED}`)
  // Presigned URL parameters and the like: a credential whose name does not say so
  out = out.replace(new RegExp(`(^|[?&;\\s"'])((?:${PARAM_NAMES})=)[^\\s&"']{1,2048}`, 'gi'), `$1$2${REDACTED}`)
  // "name": value and 'name': value where the name looks secret (quoted, escaped-quoted or bare value)
  out = out.replace(QUOTED_KEY, (_m: string, slash: string, quote: string, name: string, sep: string, value: string) => {
    const mark = value.startsWith('\\"') ? `\\"${REDACTED}\\"` : value.startsWith('"') ? `"${REDACTED}"` : value.startsWith("'") ? `'${REDACTED}'` : REDACTED
    return `${slash}${quote}${name}${slash}${quote}${sep}${mark}`
  })
  // the indented lines under `password: |` or `token:`
  out = out.replace(YAML_BLOCK, (_m: string, lead: string, header: string, block: string) => {
    const indent = /^\r?\n([ \t]+)/.exec(block)?.[1] ?? '  '
    return `${lead}${header}\n${indent}${REDACTED}${/\n$/.test(block) ? '\n' : ''}`
  })
  out = out.replace(CONNECTION_AFTER, `$1$2${REDACTED}`)
  out = out.replace(CONNECTION_FIRST, `$1$2${REDACTED}`)
  // NAME=value and name: value where the name looks secret. The boundary group (not a scan from every position) keeps it linear.
  out = out.replace(ASSIGNED, `$1$2${REDACTED}`)
  out = out.replace(ROCKET, `$1$2${REDACTED}`)
  // --api-key abc, --token "abc"
  out = out.replace(
    new RegExp(`(^|\\s)(--[\\w-]{0,80}(?:${FLAG_NAMES})[\\w-]{0,80}\\s+)(?!-)(?:${VALUE})`, 'gi'),
    `$1$2${REDACTED}`,
  )
  // docker login -p abc
  out = out.replace(
    new RegExp(`\\b((?:docker|podman)\\s+login\\b[^\\n]{0,512}?\\s)(-p|--password)(\\s+|=)(?!-)(?:${VALUE})`, 'gi'),
    `$1$2$3${REDACTED}`,
  )
  // mysql -phunter2: the attached form only, so `-p 3306`, `-p3306`, `-P` and `mkdir -p dir` stay
  out = out.replace(/(^|\s)(-p)(?!\d+(?:\s|$))(?=[^\s-])\S{3,256}/g, `$1$2${REDACTED}`)
  // curl -u user:password, --user user:password
  out = out.replace(/(^|\s)(-u|--user)(\s+|=)(?:"[^"\n]{1,512}:[^"\n]{0,512}"|'[^'\n]{1,512}:[^'\n]{0,512}'|[^\s:"']{1,256}:\S{1,512})/g, `$1$2$3${REDACTED}`)
  // email addresses: the last label must be letters, so `pkg@1.2.3` and `@types/node@18.0.0` survive
  out = out.replace(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,5}\.[A-Za-z]{2,24}\b/g, EMAIL_PLACEHOLDER)
  return out
}

/** An `-----END ... PRIVATE KEY-----` whose BEGIN was cut away: the base64 body before it goes too. */
function redactOrphanKeyEnds(text: string): string {
  const marker = new RegExp(PRIVATE_KEY_END.source, 'g')
  let out = ''
  let last = 0
  for (let m = marker.exec(text); m !== null; m = marker.exec(text)) {
    let start = m.index
    const floor = Math.max(last, start - 8192)
    // base64 lines, or the escaped `\n` of a JSON string
    while (start > floor && /[A-Za-z0-9+/=\r\n\\]/.test(text[start - 1] ?? '')) start--
    out += text.slice(last, start) + REDACTED
    last = m.index + m[0].length
  }
  return last === 0 ? text : out + text.slice(last)
}

// Usernames that are ordinary words: replacing them everywhere would only damage the text.
const GENERIC_USERNAMES = new Set([
  'root', 'user', 'users', 'home', 'admin', 'runner', 'ubuntu', 'node', 'guest', 'default', 'build', 'builder', 'test',
  'tester', 'dev', 'data', 'work', 'app', 'code', 'agent', 'nobody', 'daemon', 'www', 'www-data', 'git', 'jenkins',
])
export const USER_PLACEHOLDER = '<user>'

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function normalizeDir(dir: string): string | undefined {
  const trimmed = String(dir ?? '').replace(/\/+$/, '')
  return trimmed === '' || trimmed === '.' || !trimmed.startsWith('/') ? undefined : trimmed
}

/**
 * One absolute path: under the repository it becomes repo-relative; home alone is `~`; anything else under home is
 * `~/<path>`; any other path of two or more segments is `<path>`. A single segment (`/tmp`, `/pantheon`) stays: it
 * is readable, and a slash command is not a file.
 */
function mapPath(path: string, root: string | undefined, home: string | undefined): string {
  const bare = path.length > 1 ? path.replace(/\/+$/, '') : path
  if (root !== undefined) {
    if (bare === root) return '.'
    if (bare.startsWith(`${root}/`)) return bare.slice(root.length + 1)
  }
  if (home !== undefined) {
    if (bare === home) return '~'
    if (bare.startsWith(`${home}/`)) return HOME_PATH
  }
  return bare.indexOf('/', 1) > 0 ? PATH_PLACEHOLDER : path
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'

/**
 * Where the path of `/a/b.ts:10:5).` ends: before trailing punctuation, then before up to two `:<digits>` groups
 * (a line and a column). A backward scan of the end only, so it is linear on any token.
 */
function pathEnd(token: string): number {
  let end = token.length
  while (end > 0 && '.,;:!?)]}'.includes(token[end - 1] ?? '')) end--
  for (let group = 0; group < 2; group++) {
    let i = end
    while (i > 0 && isDigit(token[i - 1])) i--
    if (i < end && i > 0 && token[i - 1] === ':') end = i - 1
    else break
  }
  return end
}

/** Maps the path inside a token; the line suffix and punctuation after it stay in place. */
function mapToken(token: string, root: string | undefined, home: string | undefined): string {
  const end = pathEnd(token)
  return end === 0 ? token : mapPath(token.slice(0, end), root, home) + token.slice(end)
}

/**
 * Secrets and emails first, then home → `~`, the repository → repo-relative and any other absolute path → `<path>`.
 * Quoted paths and `C:\\` paths may hold spaces; an unquoted path with a space is cut at the space. Last, the home's
 * dashed form (`-Users-me-work`) becomes `<path>` and a home basename of three characters or more, as a whole word,
 * becomes `<user>` (unless it is an ordinary word such as `runner`).
 */
export function redact(text: string, ctx: RedactContext): string {
  // Secrets first: a base64 secret contains slashes and must not be half-eaten by the path rules.
  let out = redactSecrets(text)
  out = out.replace(/\bfile:\/\/(?=\/)/g, '')
  const root = normalizeDir(ctx.root)
  const home = normalizeDir(ctx.home)
  // A quoted path is taken whole, spaces included.
  out = out.replace(/(["'`])(\/(?!\/)[^"'`\r\n]{1,2048})\1/g, (_m: string, quote: string, path: string) => `${quote}${mapToken(path, root, home)}${quote}`)
  // An unquoted path starts after whitespace, a quote, a bracket, `=`, `,` or `:`; `://host/x` and `//` are not paths.
  out = out.replace(
    /(^|[\s"'`([{<=,:])(\/(?!\/)[^\s"'`<>]*)/g,
    (_m: string, lead: string, token: string) => `${lead}${mapToken(token, root, home)}`,
  )
  // A literal `~/a/b` of two segments or more (a project directory, a session store) hides its names.
  out = out.replace(
    /(^|[\s"'`([{<=,:])(~\/[^\s"'`<>/]{1,255}\/[^\s"'`<>]*)/g,
    (_m: string, lead: string, token: string) => `${lead}${HOME_PATH}${token.slice(pathEnd(token))}`,
  )
  // Windows drive paths: a segment before a separator may hold spaces.
  out = out.replace(/(^|[^\w])[A-Za-z]:\\(?:[^\\\r\n"'`<>|*?]{1,255}\\){0,64}[^\s\\"'`<>|*?]{0,255}/g, `$1${PATH_PLACEHOLDER}`)
  // What is left of the home or the root glued to a flag (`-I/Users/me/x`) still names the person's machine.
  for (const dir of [root, home]) {
    if (dir !== undefined) out = out.replace(new RegExp(`${escapeRegExp(dir)}(?![\\w@+-]|\\.\\w)[^\\s"'\`<>]*`, 'g'), HOME_PATH)
  }
  if (home !== undefined) {
    // Claude's project directories name the home in dashes (`-Users-me-work-repo`), loose or under a relative `.claude/projects/`.
    const encoded = home.replace(/[/.]/g, '-')
    out = out.replace(new RegExp(`(^|[^\\w])${escapeRegExp(encoded)}(?![A-Za-z0-9_])(?:-[\\w-]*)?`, 'g'), `$1${PATH_PLACEHOLDER}`)
    // The username on its own: a shell prompt (`me@Mac ~ %`), `Author: me`, a log line.
    const name = home.slice(home.lastIndexOf('/') + 1)
    if (name.length >= 3 && !GENERIC_USERNAMES.has(name.toLowerCase())) {
      out = out.replace(new RegExp(`(^|[^\\w])${escapeRegExp(name)}(?!\\w)`, 'gi'), `$1${USER_PLACEHOLDER}`)
    }
  }
  return out
}

/** The last `n` characters, with a leading ellipsis when something was cut. Never splits a surrogate pair. */
export function tail(text: string, n: number): string {
  const limit = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0))
  const value = String(text)
  if (value.length <= limit) return value
  if (limit === 0) return ''
  let cut = value.slice(value.length - limit)
  if (/^[\uDC00-\uDFFF]/.test(cut)) cut = cut.slice(1)
  return ELLIPSIS + cut
}

/** The first `n` characters, with a trailing ellipsis when something was cut. Never splits a surrogate pair. */
export function head(text: string, n: number): string {
  const limit = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0))
  const value = String(text)
  if (value.length <= limit) return value
  if (limit === 0) return ''
  let cut = value.slice(0, limit)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return cut + ELLIPSIS
}
