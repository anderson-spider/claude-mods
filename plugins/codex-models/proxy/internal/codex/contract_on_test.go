//go:build contract

package codex

import "testing"

func TestContractVariablesOverrideTheEndpoints(t *testing.T) {
	if authURL() != AuthURL || tokenURL() != TokenURL {
		t.Fatal("without variables the real endpoints must stay")
	}
	t.Setenv("CCMPROXY_CONTRACT_OAUTH_AUTH_URL", "http://127.0.0.1:9/authorize")
	t.Setenv("CCMPROXY_CONTRACT_OAUTH_TOKEN_URL", "http://127.0.0.1:9/token")
	if authURL() != "http://127.0.0.1:9/authorize" || tokenURL() != "http://127.0.0.1:9/token" {
		t.Fatalf("endpoints = %q, %q", authURL(), tokenURL())
	}
}
