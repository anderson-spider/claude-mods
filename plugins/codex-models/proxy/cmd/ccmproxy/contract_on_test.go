//go:build contract

package main

import "testing"

func TestContractUpstreamSkipsTheLocalCheck(t *testing.T) {
	if contractSkipsUpstreamCheck("http://127.0.0.1:9") {
		t.Fatal("skipped without the variable")
	}
	t.Setenv("CCMPROXY_CONTRACT_UPSTREAM", "http://127.0.0.1:9/")
	if !contractSkipsUpstreamCheck("http://127.0.0.1:9") {
		t.Fatal("not skipped with the variable")
	}
	if contractSkipsUpstreamCheck("http://127.0.0.1:10") {
		t.Fatal("skipped for another upstream")
	}
}
