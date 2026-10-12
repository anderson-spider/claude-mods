//go:build contract

package config

import (
	"net/url"
	"os"
	"strings"
)

// Contract build only (go build -tags contract): lets the black-box suite
// point the proxy at local fakes. Each override is an exact allow-list entry:
// the config file must name the same URL as the variable.
//
//	CCMPROXY_CONTRACT_UPSTREAM        the one extra upstream accepted
//	CCMPROXY_CONTRACT_CODEX_BASE_URL  the one extra codex.base_url accepted (http allowed)

func upstreamAllowed(upstream string) bool {
	if upstream == DefaultUpstream {
		return true
	}
	extra := strings.TrimSuffix(os.Getenv("CCMPROXY_CONTRACT_UPSTREAM"), "/")
	return extra != "" && upstream == extra
}

func validateCodexBaseURL(raw string) error {
	extra := strings.TrimSuffix(os.Getenv("CCMPROXY_CONTRACT_CODEX_BASE_URL"), "/")
	if extra != "" && raw == extra {
		if u, err := url.Parse(raw); err == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https") {
			return nil
		}
	}
	return validateHTTPSURL(raw)
}
