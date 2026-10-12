//go:build !contract

package router

import (
	"testing"
	"time"
)

func TestContractVariablesAreInertInTheDefaultBuild(t *testing.T) {
	for name, value := range map[string]string{
		"CCMPROXY_CONTRACT_UPSTREAM":        "http://127.0.0.1:9",
		"CCMPROXY_CONTRACT_CODEX_BASE_URL":  "http://127.0.0.1:9",
		"CCMPROXY_CONTRACT_OAUTH_AUTH_URL":  "http://127.0.0.1:9/authorize",
		"CCMPROXY_CONTRACT_OAUTH_TOKEN_URL": "http://127.0.0.1:9/token",
		"CCMPROXY_CONTRACT_CA_FILE":         "/nonexistent/ca.pem",
		"CCMPROXY_CONTRACT_PING_INTERVAL":   "50ms",
	} {
		t.Setenv(name, value)
	}
	if got := initialPingInterval(); got != 10*time.Second {
		t.Fatalf("interval = %v, want 10s", got)
	}
}
