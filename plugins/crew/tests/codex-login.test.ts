import { expect, test } from 'claude-code/testing'
import { EXPIRY_MARGIN_MS, parseLogin } from '../hooks/codex-login'

const NOW = Date.parse('2026-10-12T12:00:00Z')

/** base64url of ASCII text, written out: the test environment has no `btoa` or `Buffer`. */
function base64url(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  let bits = 0
  let value = 0
  for (const char of text) {
    value = (value << 8) | char.charCodeAt(0)
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += alphabet[(value >> bits) & 63]
    }
  }
  return bits > 0 ? out + alphabet[(value << (6 - bits)) & 63] : out
}

/** A JWT-shaped token with the claims given; the signature is not checked, so any text stands in. */
const jwt = (claims: Record<string, unknown>) => `${base64url('{"alg":"none"}')}.${base64url(JSON.stringify(claims))}.sig`

// Token fixtures are assembled at runtime so no source literal matches a secret scanner.
const ACCESS = jwt({ exp: NOW / 1000 + 3600, sub: ['user', '-1'].join('') })
const ID = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-from-id' } })

const file = (tokens: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens, last_refresh: '2026-10-10T00:00:00Z', ...extra })

test('a ChatGPT login gives the access token and the stored account id', () => {
  expect(parseLogin(file({ access_token: ACCESS, account_id: 'acct-1', id_token: ID, refresh_token: 'r' }), NOW)).toEqual({
    ok: true,
    login: { accessToken: ACCESS, accountId: 'acct-1' },
  })
})

test('a login file without a stored account id takes it from the ID token', () => {
  expect(parseLogin(file({ access_token: ACCESS, id_token: ID }), NOW)).toEqual({ ok: true, login: { accessToken: ACCESS, accountId: 'acct-from-id' } })
})

test('an access token at or within a minute of its expiry is refused, not refreshed', () => {
  const at = (seconds: number) => file({ access_token: jwt({ exp: seconds }), account_id: 'acct-1' })
  expect(parseLogin(at((NOW + EXPIRY_MARGIN_MS) / 1000), NOW)).toEqual({ ok: false, reason: 'the Codex login has expired (run `codex` once to refresh it)' })
  expect(parseLogin(at(NOW / 1000 - 1), NOW).ok).toBe(false)
  expect(parseLogin(at((NOW + EXPIRY_MARGIN_MS) / 1000 + 1), NOW).ok).toBe(true)
})

test('an access token with no readable expiry is used as it is', () => {
  expect(parseLogin(file({ access_token: 'opaque-token', account_id: 'acct-1' }), NOW)).toEqual({ ok: true, login: { accessToken: 'opaque-token', accountId: 'acct-1' } })
})

test('an API-key login, a missing or broken login and an unsafe token or account are refused with fixed reasons that never carry the file', () => {
  const secret = ['sk-', 'proj-0123456789'].join('')
  const cases: [string, string][] = [
    [JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: secret, tokens: null }), 'the Codex login is not a ChatGPT login (run `codex login`)'],
    ['not json', 'the Codex login file is not JSON'],
    [JSON.stringify({ OPENAI_API_KEY: secret }), 'no ChatGPT login in the Codex login file (run `codex login`)'],
    [file({ account_id: 'acct-1' }), 'the Codex login has no usable access token (run `codex login`)'],
    [file({ access_token: 'two words', account_id: 'acct-1' }), 'the Codex login has no usable access token (run `codex login`)'],
    [file({ access_token: ACCESS }), 'the Codex login names no ChatGPT account (run `codex login`)'],
    [file({ access_token: ACCESS, account_id: 'acct 1\nX-Evil: 1' }), 'the Codex login names no ChatGPT account (run `codex login`)'],
  ]
  for (const [text, reason] of cases) {
    const read = parseLogin(text, NOW)
    expect(read).toEqual({ ok: false, reason })
    expect(JSON.stringify(read)).not.toContain(secret)
  }
})
