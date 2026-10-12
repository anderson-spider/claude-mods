//go:build !contract

package main

import (
	"strings"
	"testing"
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
	if contractSkipsUpstreamCheck("http://127.0.0.1:9") {
		t.Fatal("the loopback upstream check was skipped")
	}
	if err := checkUpstream(t.Context(), "http://127.0.0.1:9", fixedLookup()); err == nil {
		t.Fatal("a loopback upstream was accepted")
	}
}

func TestVersionHasNoBuildLineInTheDefaultBuild(t *testing.T) {
	out := captureStdout(t, func() error { return run([]string{"version"}) })
	if strings.Contains(out, "  build ") || strings.Contains(out, "contract") {
		t.Fatalf("the default build's version names a contract build:\n%s", out)
	}
}
