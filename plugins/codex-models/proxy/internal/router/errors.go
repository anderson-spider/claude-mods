package router

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/translate"
)

// anthropicError is an error in the shape Anthropic clients expect. The
// fields are in the order they go out.
type anthropicError struct {
	Error errorDetail `json:"error"`
	Type  string      `json:"type"`
}

type errorDetail struct {
	Message string `json:"message"`
	Type    string `json:"type"`
}

// writeAnthropicError answers with an Anthropic error of type kind.
func writeAnthropicError(w http.ResponseWriter, status int, kind, message string) {
	writeJSON(w, status, anthropicError{Error: errorDetail{Message: message, Type: kind}, Type: "error"})
}

// writeJSON answers with v as JSON.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeCodexError maps a Codex backend failure onto an Anthropic error.
func writeCodexError(w http.ResponseWriter, err error) {
	// Never 401 toward Claude Code: it reads a 401 as its own Anthropic login
	// expiring, refreshes it and asks for /login. A Codex login problem is a
	// 403 that names the fix.
	if errors.Is(err, codex.ErrNotAuthenticated) || errors.Is(err, codex.ErrCodexCLILoginExpired) ||
		errors.Is(err, codex.ErrLoginExpired) {
		writeAnthropicError(w, http.StatusForbidden, "permission_error", err.Error())
		return
	}

	var apiErr *codex.APIError
	if !errors.As(err, &apiErr) {
		logx.Errorf("codex request failed: %v", err)
		writeAnthropicError(w, http.StatusBadGateway, "api_error", err.Error())
		return
	}

	body := bytes.TrimSpace(apiErr.Body)
	// The upstream text can echo the prompt or a token, so it is never
	// logged; only an identifier-like type and code are.
	logx.Warnf("codex backend error %d (type %q, code %q)", apiErr.StatusCode,
		logToken(lookupText(body, "error", "type")), logToken(lookupText(body, "error", "code")))

	message := upstreamMessage(body)
	if message == "" {
		message = http.StatusText(apiErr.StatusCode)
	}
	status := apiErr.StatusCode
	if status == http.StatusUnauthorized {
		status = http.StatusForbidden
		message = "the Codex backend refused the ChatGPT login; run `ccmproxy login codex` to sign in again: " + message
	}
	writeAnthropicError(w, status, codexErrorType(apiErr.StatusCode), message)
}

// upstreamMessage is what the client is told of a Codex error body: its
// error.message, else its detail, else the body itself, cleaned of control
// characters and capped (translate.CleanMessage).
func upstreamMessage(body []byte) string {
	message := lookupText(body, "error", "message")
	if message == "" {
		message = lookupText(body, "detail")
	}
	if message == "" {
		message = string(body)
	}
	return translate.CleanMessage(message)
}

// logToken keeps an upstream error type or code for the log only when it
// looks like an identifier, so free text never rides along.
func logToken(value string) string {
	if len(value) > 64 {
		return ""
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.') {
			return ""
		}
	}
	return value
}

// codexErrorType maps a Codex backend status onto Anthropic's error types.
func codexErrorType(status int) string {
	switch status {
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return "invalid_request_error"
	case http.StatusUnauthorized, http.StatusForbidden:
		return "permission_error"
	case http.StatusNotFound:
		return "not_found_error"
	case http.StatusRequestEntityTooLarge:
		return "request_too_large"
	case http.StatusTooManyRequests:
		return "rate_limit_error"
	case 529:
		return "overloaded_error"
	}
	return "api_error"
}

// errorTypeStatus is the HTTP status for an Anthropic error type, for a
// non-streaming answer that failed mid-stream.
func errorTypeStatus(kind string) int {
	switch kind {
	case "invalid_request_error":
		return http.StatusBadRequest
	case "permission_error":
		return http.StatusForbidden
	case "not_found_error":
		return http.StatusNotFound
	case "request_too_large":
		return http.StatusRequestEntityTooLarge
	case "rate_limit_error":
		return http.StatusTooManyRequests
	case "overloaded_error":
		return 529
	}
	return http.StatusBadGateway
}
