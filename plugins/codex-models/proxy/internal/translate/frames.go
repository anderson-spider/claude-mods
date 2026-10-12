package translate

import (
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The Anthropic stream events the translator writes, field order as on the
// wire.

type messageStartEvent struct {
	Type    string        `json:"type"`
	Message messageHeader `json:"message"`
}

// messageHeader opens a message: no content yet, no stop reason, and zero
// usage (the real counts come with message_delta).
type messageHeader struct {
	ID           string     `json:"id"`
	Type         string     `json:"type"`
	Role         string     `json:"role"`
	Model        string     `json:"model"`
	Content      []struct{} `json:"content"`
	StopReason   *string    `json:"stop_reason"`
	StopSequence *string    `json:"stop_sequence"`
	Usage        tokenUsage `json:"usage"`
}

// tokenUsage is Anthropic's usage: input_tokens counts only fresh input, and
// the cache fields appear only when there was caching.
type tokenUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens,omitempty"`
}

type blockStartEvent struct {
	Type         string `json:"type"`
	Index        int    `json:"index"`
	ContentBlock any    `json:"content_block"`
}

type blockDeltaEvent struct {
	Type  string `json:"type"`
	Index int    `json:"index"`
	Delta any    `json:"delta"`
}

type blockStopEvent struct {
	Type  string `json:"type"`
	Index int    `json:"index"`
}

type messageDeltaEvent struct {
	Type  string     `json:"type"`
	Delta stopDelta  `json:"delta"`
	Usage tokenUsage `json:"usage"`
}

type stopDelta struct {
	StopReason   string  `json:"stop_reason"`
	StopSequence *string `json:"stop_sequence"`
}

type messageStopEvent struct {
	Type string `json:"type"`
}

type errorEvent struct {
	Type  string      `json:"type"`
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// Content blocks, as opened by content_block_start and as they stand in an
// assembled message.

type textBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type thinkingBlock struct {
	Type      string `json:"type"`
	Thinking  string `json:"thinking"`
	Signature string `json:"signature"`
}

type toolUseBlock struct {
	Type  string          `json:"type"`
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// emptyInput is a tool_use block's input at content_block_start, and the
// input of a call that takes no arguments.
var emptyInput = json.RawMessage(`{}`)

// Deltas.

type textDelta struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type thinkingDelta struct {
	Type     string `json:"type"`
	Thinking string `json:"thinking"`
}

type signatureDelta struct {
	Type      string `json:"type"`
	Signature string `json:"signature"`
}

type inputJSONDelta struct {
	Type        string `json:"type"`
	PartialJSON string `json:"partial_json"`
}

// sseFrame writes one server-sent event named after its type.
func sseFrame(event string, data any) []byte {
	payload := encode(data)
	out := make([]byte, 0, len(event)+len(payload)+16)
	out = append(out, "event: "...)
	out = append(out, event...)
	out = append(out, "\ndata: "...)
	out = append(out, payload...)
	return append(out, '\n', '\n')
}

// Errors.

// anthropicErrorTypes are the error types the Messages API itself uses.
var anthropicErrorTypes = map[string]bool{
	"invalid_request_error": true,
	"permission_error":      true,
	"not_found_error":       true,
	"request_too_large":     true,
	"rate_limit_error":      true,
	"api_error":             true,
	"overloaded_error":      true,
}

// errorKind names an upstream failure with an Anthropic error type, from its
// type or else its code; whatever matches nothing is api_error. An
// authentication failure is permission_error on purpose: Claude Code takes
// authentication_error as its own Anthropic login failing.
func errorKind(kind, code string) string {
	for _, candidate := range []string{kind, code} {
		candidate = strings.ToLower(strings.TrimSpace(candidate))
		switch candidate {
		case "":
			continue
		case "authentication_error", "invalid_api_key", "unauthorized":
			return "permission_error"
		case "rate_limit_exceeded", "usage_limit_reached", "insufficient_quota", "rate_limit":
			return "rate_limit_error"
		case "server_is_overloaded", "overloaded", "slow_down":
			return "overloaded_error"
		case "context_length_exceeded", "invalid_prompt", "invalid_request", "bad_request":
			return "invalid_request_error"
		case "not_found", "model_not_found":
			return "not_found_error"
		}
		if anthropicErrorTypes[candidate] {
			return candidate
		}
	}
	return "api_error"
}

// maxMessageRunes is how much of an upstream error message reaches the
// client.
const maxMessageRunes = 300

// CleanMessage prepares an upstream error message for the client. Control
// characters, whitespace and invalid UTF-8 separate words, which are joined
// by single spaces; past maxMessageRunes the text is cut and ends in "…",
// never in a space. An upstream may echo a prompt or a token in its error, so
// the text goes out bounded, and is never logged.
func CleanMessage(message string) string {
	var out strings.Builder
	written := 0
	gap := false // a separator was seen since the last word character
	for _, r := range message {
		if r == utf8.RuneError || unicode.IsControl(r) || unicode.IsSpace(r) {
			gap = out.Len() > 0
			continue
		}
		need := 1
		if gap {
			need = 2
		}
		if written+need > maxMessageRunes {
			out.WriteString("…")
			return out.String()
		}
		if gap {
			out.WriteByte(' ')
			written++
			gap = false
		}
		out.WriteRune(r)
		written++
	}
	return out.String()
}
