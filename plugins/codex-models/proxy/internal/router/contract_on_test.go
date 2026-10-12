//go:build contract

package router

import (
	"testing"
	"time"
)

func TestContractVariableSetsTheKeepaliveInterval(t *testing.T) {
	if got := initialPingInterval(); got != 10*time.Second {
		t.Fatalf("default = %v", got)
	}
	t.Setenv("CCMPROXY_CONTRACT_PING_INTERVAL", "50ms")
	if got := initialPingInterval(); got != 50*time.Millisecond {
		t.Fatalf("interval = %v, want 50ms", got)
	}
}
