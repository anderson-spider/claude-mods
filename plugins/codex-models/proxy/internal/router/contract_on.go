//go:build contract

package router

import (
	"os"
	"time"
)

// Contract build only: CCMPROXY_CONTRACT_PING_INTERVAL (a Go duration such
// as 50ms) replaces the keepalive interval. A bad value panics.
func initialPingInterval() time.Duration {
	v := os.Getenv("CCMPROXY_CONTRACT_PING_INTERVAL")
	if v == "" {
		return defaultPingInterval
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		panic("CCMPROXY_CONTRACT_PING_INTERVAL: invalid duration " + v)
	}
	return d
}
