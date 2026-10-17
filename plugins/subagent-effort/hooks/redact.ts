// Redaction for text that leaves the machine: paths, secrets and email addresses.
// Pure and total: it never throws and the same input always gives the same output. Every pattern is linear on hostile
// input (bounded quantifiers, a boundary group instead of a scan from each position), because the text is agent output.
// Over-redaction is the safe side: a lost word costs the rating little, a leaked credential costs the person a lot.

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

// Prefixes only: a linear scanner consumes the complete value, with no length cap or quote backtracking.
const QUOTED_KEY = new RegExp(`(?<!\\\\)(\\\\*)(["'])(${NAME})\\1\\2(\\s*(?:=>|:=|<-|[:=])\\s*)`, 'gi')
// `NAME: |` or `NAME:` with the secret on the indented lines under it
const YAML_BLOCK = new RegExp(`(^|[^\\w.-])(${NAME}[ \\t]*:[ \\t]*(?:[|>][-+0-9]{0,3})?[ \\t]*)(\\r?\\n(?:[ \\t]+[^\\r\\n]*(?:\\r?\\n|$)){1,64})`, 'gi')
// `Server=x;Password=P@ss word;`: after a `;` the value runs to the next `;` (or the line's end), spaces included
const CONNECTION_AFTER = new RegExp(`(;[ \\t]*)(${NAME}[ \\t]*=[ \\t]*)[^;\\r\\n"']+`, 'gi')
const CONNECTION_FIRST = new RegExp(`(^|[\\r\\n])([ \\t]*${NAME}[ \\t]*=[ \\t]*)[^;\\r\\n"']+(?=;)`, 'gi')
const ASSIGNED = new RegExp(`(^|[^\\w.-])(${NAME}[ \\t]*(?::=|<-|=(?!>)|:)[ \\t]*)`, 'gi')
// `=>` only before a quoted value: bare arrow-function code stays readable.
const ROCKET = new RegExp(`(^|[^\\w.-])(${NAME}[ \\t]*=>[ \\t]*)(?=["'])`, 'gi')

/** Hide entire values after recognized prefixes, preserving JSON quotes and stopping a bare JSON value at delimiters. */
function hideValues(text: string, prefix: RegExp, json = false): string {
  prefix.lastIndex = 0
  const chunks: string[] = []
  let last = 0
  for (let match = prefix.exec(text); match !== null; match = prefix.exec(text)) {
    const start = prefix.lastIndex
    let opening = start
    while (text[opening] === '\\') opening++
    const slashes = opening - start
    const escaped = slashes > 0
    const quote = text[opening]
    let end = start
    let mark = REDACTED
    if (quote === '"' || quote === "'") {
      end = opening + 1
      while (end < text.length) {
        if (text[end] === '\\') {
          if (!escaped) { end = Math.min(text.length, end + 2); continue }
          let run = end
          while (text[run] === '\\') run++
          // The closing delimiter has the opening escape depth; deeper runs encode quotes inside the value.
          if (run === end + slashes && text[run] === quote) { end = run + 1; break }
          end = Math.min(text.length, run + 1)
        } else if (!escaped && text[end] === quote) { end++; break }
        else end++
      }
      if (json) {
        const delimiter = text.slice(start, opening + 1)
        mark = `${delimiter}${REDACTED}${delimiter}`
      }
    } else {
      // Keep our marker atomic, but consume any suffix left by another redaction rule too.
      const atomic = text.startsWith(REDACTED, end)
      if (atomic) end += REDACTED.length
      const stop = json ? /[\s,}\]"'\\]/ : /[\s"']/
      // Delimiters after an existing marker belong to surrounding JSON/connection strings, not to the secret.
      if (!(atomic && /[;&\s,}\]"'\\]/.test(text[end] ?? ''))) {
        while (end < text.length && !stop.test(text[end]!)) end++
      }
    }
    if (end === start) continue
    chunks.push(text.slice(last, start), mark)
    last = end
    // The next prefix search starts beyond the consumed secret, so its contents cannot cause repeated rescans.
    prefix.lastIndex = end
  }
  chunks.push(text.slice(last))
  return chunks.join('')
}

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
  out = hideValues(out, QUOTED_KEY, true)
  // the indented lines under `password: |` or `token:`
  out = out.replace(YAML_BLOCK, (_m: string, lead: string, header: string, block: string) => {
    const indent = /^\r?\n([ \t]+)/.exec(block)?.[1] ?? '  '
    return `${lead}${header}\n${indent}${REDACTED}${/\n$/.test(block) ? '\n' : ''}`
  })
  out = out.replace(CONNECTION_AFTER, `$1$2${REDACTED}`)
  out = out.replace(CONNECTION_FIRST, `$1$2${REDACTED}`)
  // NAME=value and name: value where the name looks secret. The boundary group (not a scan from every position) keeps it linear.
  out = hideValues(out, ASSIGNED)
  out = hideValues(out, ROCKET)
  // --api-key abc, --token "abc"
  out = hideValues(out, new RegExp(`(^|\\s)(--[\\w-]{0,80}(?:${FLAG_NAMES})[\\w-]{0,80}\\s+)(?!-)`, 'gi'))
  // docker login -p abc
  out = hideValues(out, new RegExp(`\\b((?:docker|podman)\\s+login\\b[^\\n]{0,512}?\\s)(-p|--password)(\\s+|=)(?!-)`, 'gi'))
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
  // Directories under /Users or /home that belong to no one.
  'shared', 'public', 'library',
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

/** An attached flag is unambiguously a path, even if its absolute path has only one segment. */
function mapAbsolute(token: string, root: string | undefined, home: string | undefined, flag = false): string {
  const mapped = token.startsWith('/') ? mapToken(token, root, home) : PATH_PLACEHOLDER + token.slice(pathEnd(token))
  return flag && mapped.startsWith('/') ? PATH_PLACEHOLDER + token.slice(pathEnd(token)) : mapped
}

// Short options have a fixed name; long options separate their argument with '='. Never fold a relative argument into the name.
const PATH_FLAG = String.raw`(?:--[A-Za-z][\w-]*=|-(?:isystem|iquote|idirafter|imacros|include|[A-Za-z]))`
// Require a host, its separator and a share: quoted escape strings such as "\\n" are not UNC paths.
const UNC_HEAD = String.raw`\\{2,}[\w.-]+\\+(?=[^\\\s"'\x60<>])`

/** Each quoted path is consumed once, to its own closing quote or EOF, without regex quote backtracking. */
function hideQuotedPaths(text: string, root: string | undefined, home: string | undefined): string {
  const prefix = new RegExp(String.raw`(["'\x60])(${PATH_FLAG})?(?=\/(?!\/)|[A-Za-z]:\\|${UNC_HEAD})`, 'g')
  const chunks: string[] = []
  let last = 0
  for (let match = prefix.exec(text); match !== null; match = prefix.exec(text)) {
    const start = prefix.lastIndex
    const quote = match[1]!
    let end = start
    while (end < text.length && text[end] !== quote && text[end] !== '\n' && text[end] !== '\r') {
      if (text[start] === '/' && text[end] === '\\' && text[end + 1] === quote) end += 2
      else end++
    }
    const closed = text[end] === quote
    chunks.push(text.slice(last, start), mapAbsolute(text.slice(start, end), root, home, !!match[2]), closed ? quote : '')
    last = end + (closed ? 1 : 0)
    prefix.lastIndex = last
  }
  chunks.push(text.slice(last))
  return chunks.join('')
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
  // Quoted paths include spaces and the other quote kind; scan them before processing bare flags/UNC paths.
  out = hideQuotedPaths(out, root, home)
  // A backslash run is considered only at its start, avoiding repeated scans when a UNC prefix is incomplete.
  out = out.replace(new RegExp(String.raw`(?<!\\)${UNC_HEAD}[^\s"'\x60<>]*`, 'g'), token => `${PATH_PLACEHOLDER}${token.slice(pathEnd(token))}`)
  // Flags may be glued to absolute paths outside the known home/repository too.
  out = out.replace(
    new RegExp(String.raw`(^|[\s"'\x60([{<=,:])(${PATH_FLAG})(\/(?!\/)[^\s"'\x60<>]*|[A-Za-z]:\\(?:[^\\\r\n"'\x60<>|*?]{1,255}\\){0,64}[^\s\\"'\x60<>|*?]{0,255})`, 'g'),
    (_m: string, lead: string, flag: string, token: string) => `${lead}${flag}${mapAbsolute(token, root, home, true)}`,
  )
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
