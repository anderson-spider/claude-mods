//go:build !contract

package config

// The default build: no override exists, and nothing here reads the
// environment. contract_on.go is the test build's version of these two.

// upstreamAllowed accepts DefaultUpstream only.
func upstreamAllowed(upstream string) bool { return upstream == DefaultUpstream }

// validateCodexBaseURL accepts an https URL only.
func validateCodexBaseURL(raw string) error { return requireHTTPS(raw) }
