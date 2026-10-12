// The Codex CLI's ChatGPT login, as `codex login` leaves it in `~/.codex/auth.json`. Pure: the hook reads the file and
// passes its text. crew only reads the login: it never refreshes or writes it, so the CLI stays its one owner.

/** What a request on the login carries: the bearer and the ChatGPT account it acts for. */
export type Login = { accessToken: string; accountId: string }

export type LoginRead = { ok: true; login: Login } | { ok: false; reason: string }

/** How long before its expiry an access token is no longer used: a step may outlast the token otherwise. */
export const EXPIRY_MARGIN_MS = 60_000

/** The token shape the `Authorization` header can carry unbroken. */
const TOKEN = /^[\x21-\x7e]{1,16384}$/
const ACCOUNT = /^[\w-]{1,128}$/

/** One JWT segment's JSON, or undefined. Hand-decoded: the plugin environment has no `atob` or `Buffer`. */
function jwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1]
  if (!part) return undefined
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of part.replace(/=+$/, '')) {
    const index = alphabet.indexOf(char)
    if (index < 0) return undefined
    value = (value << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
    }
  }
  try {
    // Percent-encoding each byte lets decodeURIComponent read the UTF-8 the payload is written in.
    const parsed: unknown = JSON.parse(decodeURIComponent(bytes.map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('')))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The account id the ID token names, for a login file that does not store it beside the tokens. */
function accountOf(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined
  const auth = jwtPayload(idToken)?.['https://api.openai.com/auth']
  const id = auth && typeof auth === 'object' ? (auth as Record<string, unknown>).chatgpt_account_id : undefined
  return typeof id === 'string' ? id : undefined
}

/**
 * The login in `auth.json`'s text at `now` (ms since epoch). The reasons are fixed phrases: no token or file text is
 * in them. An access token whose `exp` is near is refused, not refreshed: running `codex` refreshes it.
 */
export function parseLogin(text: string, now: number): LoginRead {
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'the Codex login file is not JSON' }
  }
  const fields = file && typeof file === 'object' ? (file as Record<string, unknown>) : {}
  // An API-key login has no ChatGPT account: its requests would not run on the subscription.
  if (typeof fields.auth_mode === 'string' && fields.auth_mode !== 'chatgpt') return { ok: false, reason: 'the Codex login is not a ChatGPT login (run `codex login`)' }
  const tokens = fields.tokens
  if (!tokens || typeof tokens !== 'object') return { ok: false, reason: 'no ChatGPT login in the Codex login file (run `codex login`)' }
  const { access_token: accessToken, account_id: storedAccount, id_token: idToken } = tokens as Record<string, unknown>
  if (typeof accessToken !== 'string' || !TOKEN.test(accessToken)) return { ok: false, reason: 'the Codex login has no usable access token (run `codex login`)' }
  const accountId = typeof storedAccount === 'string' && storedAccount ? storedAccount : accountOf(idToken)
  if (accountId === undefined || !ACCOUNT.test(accountId)) return { ok: false, reason: 'the Codex login names no ChatGPT account (run `codex login`)' }
  const exp = jwtPayload(accessToken)?.exp
  if (typeof exp === 'number' && exp * 1000 - EXPIRY_MARGIN_MS <= now) {
    return { ok: false, reason: 'the Codex login has expired (run `codex` once to refresh it)' }
  }
  return { ok: true, login: { accessToken, accountId } }
}
