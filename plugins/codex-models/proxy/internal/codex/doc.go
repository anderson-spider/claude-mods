// Package codex authenticates against the OpenAI Codex (ChatGPT subscription)
// backend and speaks its Responses API. The OAuth client id, endpoints and
// redirect URI mirror the Codex CLI, which is what the subscription endpoint
// accepts; the flow itself is a standard OAuth 2.0 authorization code grant
// with PKCE (RFC 7636).
//
// The pieces:
//
//   - oauth.go and login.go: the token endpoint client (Exchange, Refresh)
//     and the interactive login with its loopback callback;
//   - token.go: the credential set and the claims read from its JWTs;
//   - store.go, refresh.go, lock.go, write.go: where the login lives on disk,
//     how it is refreshed, and the two flocks that serialise that across
//     processes;
//   - paths.go and layout.go: where the Codex CLI keeps its login
//     (~/.codex/auth.json, which this proxy only ever reads), and the two
//     on-disk layouts: this proxy's own, and the Codex CLI's, which an
//     explicit auth_file may use and is then written in;
//   - responses.go: the Responses API call;
//   - catalog.go and registry.go: the models offered and how a client's
//     model name resolves to one.
//
// Nothing here follows a redirect: every request carries a token or a code.
package codex
