//go:build contract

package codex

import "os"

// Contract build only: CCMPROXY_CONTRACT_OAUTH_AUTH_URL and
// CCMPROXY_CONTRACT_OAUTH_TOKEN_URL replace the OAuth endpoints.

func authURL() string  { return envOr("CCMPROXY_CONTRACT_OAUTH_AUTH_URL", AuthURL) }
func tokenURL() string { return envOr("CCMPROXY_CONTRACT_OAUTH_TOKEN_URL", TokenURL) }

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
