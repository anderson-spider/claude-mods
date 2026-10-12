//go:build !contract

package config

import (
	"strings"
	"testing"
)

// The contract variables must do nothing in the default build.
func TestContractVariablesAreInertInTheDefaultBuild(t *testing.T) {
	for name, value := range map[string]string{
		"CCMPROXY_CONTRACT_UPSTREAM":        "http://127.0.0.1:9",
		"CCMPROXY_CONTRACT_REMOTE":          "http://127.0.0.1:9",
		"CCMPROXY_CONTRACT_OAUTH_AUTH_URL":  "http://127.0.0.1:9/authorize",
		"CCMPROXY_CONTRACT_OAUTH_TOKEN_URL": "http://127.0.0.1:9/token",
		"CCMPROXY_CONTRACT_CA_FILE":         "/nonexistent/ca.pem",
		"CCMPROXY_CONTRACT_PING_INTERVAL":   "50ms",
	} {
		t.Setenv(name, value)
	}
	cfg := Default()
	cfg.ListenHTTP = "127.0.0.1:8080"
	cfg.Upstream = "http://127.0.0.1:9"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "upstream") {
		t.Fatalf("loopback upstream: err = %v, want an upstream refusal", err)
	}
	cfg = Default()
	cfg.ListenHTTP = "127.0.0.1:8080"
	cfg.Codex.Remote = "http://127.0.0.1:9"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "codex.remote") {
		t.Fatalf("http codex base URL: err = %v, want a remote refusal", err)
	}
}
