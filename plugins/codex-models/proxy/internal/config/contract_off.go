//go:build !contract

package config

// The default build: no override exists, and nothing here reads the
// environment. contract_on.go is the test build's version of these two.

// upstreamAllowed accepts DefaultUpstream only.
func upstreamAllowed(upstream string) bool { return upstream == DefaultUpstream }

// validateRemote accepts an HTTP or HTTPS remote with no credentials or local address.
func validateRemote(raw string) error { return requireRemote(raw) }

// RemoteAllowsLoopback is false in a normal build, regardless of environment.
func RemoteAllowsLoopback(raw string) bool { return false }
