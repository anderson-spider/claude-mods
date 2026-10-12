// Package translate converts between the two wire formats the proxy speaks:
// the Anthropic Messages API on the Claude Code side and the OpenAI Responses
// API on the Codex side.
//
// Requests go one way (ClaudeToCodex), answers the other (StreamTranslator,
// folded into one message by MessageAssembler when the client did not stream).
// StripProxySignatures cleans a request bound for Anthropic of the reasoning
// state this proxy handed out for Codex turns.
//
// The package reads JSON written by parties it does not control, so a value of
// an unexpected type counts as absent instead of failing the whole request or
// event (see json.go). Values it only carries along (tool schemas, tool inputs,
// content blocks it does not rewrite) stay json.RawMessage and are never
// decoded into Go values and back.
package translate
