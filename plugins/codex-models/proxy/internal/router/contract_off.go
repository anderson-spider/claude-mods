//go:build !contract

package router

import "time"

// initialPingInterval is the keepalive interval a new Router starts with.
func initialPingInterval() time.Duration { return defaultPingInterval }
