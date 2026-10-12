//go:build contract

package codex

import (
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
	"os"
	"strconv"
)

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

func CallbackPort() int {
	if n, err := strconv.Atoi(os.Getenv("CCMPROXY_CONTRACT_CALLBACK_PORT")); err == nil && n > 0 && n <= 65535 {
		return n
	}
	return config.CallbackPort
}
