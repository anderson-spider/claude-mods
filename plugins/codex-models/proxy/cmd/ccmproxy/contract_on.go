//go:build contract

package main

import (
	"os"
	"strings"
)

// Contract build only: the upstream named by CCMPROXY_CONTRACT_UPSTREAM
// (a loopback fake) skips the "resolves to this machine" refusal.
func contractSkipsUpstreamCheck(upstream string) bool {
	extra := strings.TrimSuffix(os.Getenv("CCMPROXY_CONTRACT_UPSTREAM"), "/")
	return extra != "" && upstream == extra
}
