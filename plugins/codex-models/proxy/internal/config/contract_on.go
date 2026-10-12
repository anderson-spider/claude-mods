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
//	CCMPROXY_CONTRACT_REMOTE          one accepted TLS fake codex.remote

func upstreamAllowed(upstream string) bool {
	if upstream == DefaultUpstream {
		return true
	}
	extra := contractURL("CCMPROXY_CONTRACT_UPSTREAM")
	return extra != "" && upstream == extra
}

func validateRemote(raw string) error {
	if RemoteAllowsLoopback(raw) {
		return requireHTTPS(raw)
	}
	return requireRemote(raw)
}

// RemoteAllowsLoopback is the sole TLS fake-remote exception in contract builds.
func RemoteAllowsLoopback(raw string) bool {
	extra := contractURL("CCMPROXY_CONTRACT_REMOTE")
	if extra == "" || raw != extra {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && !strings.Contains(raw, "#")
}

// contractURL reads a contract variable without its trailing "/", as the
// loaded config holds URLs.
func contractURL(name string) string {
	return strings.TrimSuffix(os.Getenv(name), "/")
}
