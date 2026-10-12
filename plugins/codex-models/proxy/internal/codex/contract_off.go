//go:build !contract

package codex

// authURL and tokenURL are the OAuth endpoints in use: the real ones.
func authURL() string  { return AuthURL }
func tokenURL() string { return TokenURL }
