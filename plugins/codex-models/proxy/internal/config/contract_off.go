//go:build !contract

package config

// upstreamAllowed reports whether upstream may be configured. The default
// build accepts DefaultUpstream only.
func upstreamAllowed(upstream string) bool { return upstream == DefaultUpstream }

// validateCodexBaseURL checks codex.base_url. The default build accepts
// https URLs only.
func validateCodexBaseURL(raw string) error { return validateHTTPSURL(raw) }
