//go:build contract

package config

import (
	"net/url"
	"os"
	"strings"
)

// The contract build (go build -tags contract) only: the black-box suite
// points the proxy at local fakes. Each variable adds exactly one accepted
// value, and the config file must name the same URL; everything else is
// checked as in the default build.
//
//	CCMPROXY_CONTRACT_UPSTREAM        one more accepted upstream
//	CCMPROXY_CONTRACT_CODEX_BASE_URL  one more accepted codex.base_url (http allowed)

func upstreamAllowed(upstream string) bool {
	if upstream == DefaultUpstream {
		return true
	}
	extra := contractURL("CCMPROXY_CONTRACT_UPSTREAM")
	return extra != "" && upstream == extra
}

func validateCodexBaseURL(raw string) error {
	if extra := contractURL("CCMPROXY_CONTRACT_CODEX_BASE_URL"); extra != "" && raw == extra {
		if u, err := url.Parse(raw); err == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https") {
			return nil
		}
	}
	return requireHTTPS(raw)
}

// contractURL reads a contract variable without its trailing "/", as the
// loaded config holds URLs.
func contractURL(name string) string {
	return strings.TrimSuffix(os.Getenv(name), "/")
}
