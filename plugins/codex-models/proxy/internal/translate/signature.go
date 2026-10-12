package translate

import "strings"

// SignatureMarker starts the signature of every thinking block this proxy
// gives Claude Code for a Codex turn; what follows it is the Codex
// encrypted_content, unchanged.
//
// Claude Code stores these blocks in its transcripts and replays them on later
// turns, to whichever model the session uses then. The marker is how both
// directions tell the proxy's blocks from Anthropic's: Codex gets back only
// its own reasoning state, and Anthropic never sees it. Changing the marker
// or the encoding breaks every transcript already written.
const SignatureMarker = "ccmp1:"

// MarkSignature turns Codex reasoning state into a thinking signature.
func MarkSignature(encrypted string) string {
	if encrypted == "" {
		return ""
	}
	return SignatureMarker + encrypted
}

// codexState returns the reasoning state inside a signature this proxy
// issued, and false for any other signature.
func codexState(signature string) (string, bool) {
	return strings.CutPrefix(signature, SignatureMarker)
}
