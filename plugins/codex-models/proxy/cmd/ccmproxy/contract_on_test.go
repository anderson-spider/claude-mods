//go:build contract

package main

import (
	"strings"
	"testing"
)

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

func TestVersionMarksTheContractBuild(t *testing.T) {
	out := captureStdout(t, func() error { return run([]string{"version"}) })
	lines := strings.Split(out, "\n")
	if len(lines) < 4 || lines[3] != "  build    contract (test injection points on; not for installation)" {
		t.Fatalf("version does not mark the contract build on its fourth line:\n%s", out)
	}
}
