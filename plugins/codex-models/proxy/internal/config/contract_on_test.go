//go:build contract

package config

import "testing"

func TestContractVariablesOverrideTheRefusals(t *testing.T) {
	t.Setenv("CCMPROXY_CONTRACT_UPSTREAM", "http://127.0.0.1:9/")
	t.Setenv("CCMPROXY_CONTRACT_CODEX_BASE_URL", "http://127.0.0.1:10")
	cfg := Default()
	cfg.ListenHTTP = "127.0.0.1:8080"
	cfg.Upstream = "http://127.0.0.1:9"
	cfg.Codex.BaseURL = "http://127.0.0.1:10"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate with the variables: %v", err)
	}
	// Only the named URLs are allowed, not any URL.
	cfg.Upstream = "http://127.0.0.1:11"
	if cfg.Validate() == nil {
		t.Fatal("an upstream other than the variable's was accepted")
	}
	cfg.Upstream = DefaultUpstream
	cfg.Codex.BaseURL = "http://127.0.0.1:12"
	if cfg.Validate() == nil {
		t.Fatal("a base URL other than the variable's was accepted")
	}
}
