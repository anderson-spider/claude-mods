package router

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/jclab-joseph/claude-code-model-proxy/internal/codex"
	"github.com/jclab-joseph/claude-code-model-proxy/internal/logx"
	"github.com/jclab-joseph/claude-code-model-proxy/internal/tokenize"
	"github.com/jclab-joseph/claude-code-model-proxy/internal/translate"
	"github.com/tidwall/gjson"
)

// sseReadLimit caps a single upstream event payload.
const sseReadLimit = 32 << 20

// resolveEffort decides the reasoning effort for one request, and is the only
// place that decides it.
//
// The order is: an effort pinned in the model name, then whatever the client
// asked for, then the model's default. Claude Code sends its /effort and
// --effort choice as output_config.effort, which is why a per-effort model id
// is not needed to control it. The result is always a concrete level, clamped
// to what the real model supports.
func resolveEffort(body []byte, resolution codex.Resolution) string {
	effort := resolution.Effort
	if effort == "" {
		effort = translate.EffortFrom(body, resolution.Model.DefaultEffort)
	}
	return resolution.Model.ClampEffort(effort)
}

// codexSessionID derives the Codex Session_id from Claude Code's
// metadata.user_id. Reusing one id per Claude Code session keeps a
// conversation on one upstream session, but the raw value carries Anthropic
// account and device identifiers, so only an HMAC-SHA256 of it keyed with the
// install's session_salt is sent: stable for the same input, meaningless
// without the salt. It is shaped as a version 4 UUID, like the ids the Codex
// CLI sends. Without a user_id a random id is used.
func codexSessionID(salt, userID string) string {
	if userID == "" {
		return codex.NewSessionID()
	}
	mac := hmac.New(sha256.New, []byte(salt))
	mac.Write([]byte(userID))
	b := mac.Sum(nil)[:16]
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// serveCodexMessages answers a Messages request from the Codex backend. effort
// comes from resolveEffort, so the value logged upstream and the value sent
// are the same one.
func (r *Router) serveCodexMessages(w http.ResponseWriter, req *http.Request, body []byte, resolution codex.Resolution, effort string) {
	if r.backend == nil {
		writeAnthropicError(w, http.StatusServiceUnavailable, "api_error", "the Codex backend is not configured")
		return
	}

	if logx.Enabled(logx.LevelDebug) {
		logx.Debugf("codex effort: model name=%q client=%q -> %q (supported: %s)",
			resolution.Effort, gjson.GetBytes(body, "output_config.effort").String(),
			effort, strings.Join(resolution.Model.ReasoningLevel, ","))
	}

	translated, err := translate.ClaudeToCodex(translate.Options{
		Model:         resolution.Model.ID,
		Effort:        effort,
		DefaultEffort: resolution.Model.DefaultEffort,
	}, body)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}

	sessionID := codexSessionID(r.cfg.SessionSalt, gjson.GetBytes(body, "metadata.user_id").String())
	resp, err := r.backend.Responses(req.Context(), translated.Body, sessionID)
	if err != nil {
		writeCodexError(w, err)
		return
	}
	defer func() { _ = resp.Body.Close() }()

	streaming := gjson.GetBytes(body, "stream").Bool()
	if streaming {
		r.streamCodex(w, req, resp.Body, resolution, translated.ToolNames)
		return
	}
	r.bufferCodex(w, resp.Body, resolution, translated.ToolNames)
}

// streamCodex relays the upstream event stream as Anthropic SSE.
func (r *Router) streamCodex(w http.ResponseWriter, req *http.Request, upstream io.Reader, resolution codex.Resolution, toolNames map[string]string) {
	header := w.Header()
	header.Set("Content-Type", "text/event-stream; charset=utf-8")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	// Buffering proxies would defeat the point of streaming.
	header.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	controller := http.NewResponseController(w)
	_ = controller.Flush()

	translator := translate.NewStreamTranslator(resolution.Model.ID, toolNames)
	write := func(frames []byte) bool {
		if len(frames) == 0 {
			return true
		}
		if _, err := w.Write(frames); err != nil {
			logx.Debugf("codex stream: client write failed: %v", err)
			return false
		}
		_ = controller.Flush()
		return true
	}

	err := scanSSE(upstream, func(payload []byte) bool {
		return write(translator.Event(payload))
	})
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, req.Context().Err()) {
		logx.Warnf("codex stream: upstream read failed: %v", err)
		write(translator.Error("api_error", "upstream stream ended: "+err.Error()))
	}
	write(translator.Close())
}

// bufferCodex answers a client that did not ask for streaming. The Codex
// backend only serves streaming responses, so the events go through the same
// translator as the streaming path and are then folded into one message.
func (r *Router) bufferCodex(w http.ResponseWriter, upstream io.Reader, resolution codex.Resolution, toolNames map[string]string) {
	translator := translate.NewStreamTranslator(resolution.Model.ID, toolNames)
	assembler := translate.NewMessageAssembler()

	err := scanSSE(upstream, func(payload []byte) bool {
		assembler.Write(translator.Event(payload))
		return true
	})
	if err != nil && !errors.Is(err, io.EOF) {
		writeAnthropicError(w, http.StatusBadGateway, "api_error", "upstream stream ended: "+err.Error())
		return
	}
	assembler.Write(translator.Close())

	if kind, message, failed := assembler.Err(); failed {
		writeAnthropicError(w, errorTypeStatus(kind), kind, message)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(assembler.Message())
}

// writeCodexTokenCount answers count_tokens for a Codex model with a local
// estimate, since the backend exposes no counting endpoint.
func (r *Router) writeCodexTokenCount(w http.ResponseWriter, body []byte) {
	count := tokenize.EstimateClaudeRequest(body)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int64{"input_tokens": count})
}

// writeCodexError maps a backend failure onto an Anthropic error response.
func writeCodexError(w http.ResponseWriter, err error) {
	// Never 401 toward Claude Code: it reads a 401 as its own Anthropic login
	// expiring, refreshes it and asks for /login. A Codex login problem is
	// a 403 that names the fix.
	if errors.Is(err, codex.ErrNotAuthenticated) || errors.Is(err, codex.ErrCodexCLILoginExpired) ||
		errors.Is(err, codex.ErrLoginExpired) {
		writeAnthropicError(w, http.StatusForbidden, "permission_error", err.Error())
		return
	}

	var apiErr *codex.APIError
	if errors.As(err, &apiErr) {
		body := bytes.TrimSpace(apiErr.Body)
		// Surface the upstream message rather than its JSON envelope when
		// one is available. It can echo the prompt or a token, so it is
		// never logged and reaches the client cleaned and capped.
		message := string(body)
		if text := gjson.GetBytes(body, "error.message").String(); text != "" {
			message = text
		} else if text := gjson.GetBytes(body, "detail").String(); text != "" {
			message = text
		}
		message = translate.CleanMessage(message)
		if message == "" {
			message = http.StatusText(apiErr.StatusCode)
		}
		logx.Warnf("codex backend error %d (type %q, code %q)", apiErr.StatusCode,
			logToken(gjson.GetBytes(body, "error.type").String()), logToken(gjson.GetBytes(body, "error.code").String()))

		status := apiErr.StatusCode
		if status == http.StatusUnauthorized {
			status = http.StatusForbidden
			message = "the Codex backend refused the ChatGPT login; run `ccmproxy login codex` to sign in again: " + message
		}
		writeAnthropicError(w, status, codexErrorType(apiErr.StatusCode), message)
		return
	}

	logx.Errorf("codex request failed: %v", err)
	writeAnthropicError(w, http.StatusBadGateway, "api_error", err.Error())
}

// logToken keeps an upstream error type or code for the log only when it
// looks like an identifier, so free text can never ride along.
func logToken(value string) string {
	if len(value) > 64 {
		return ""
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.') {
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

// scanSSE reads a Server-Sent Events stream and invokes onData once per event
// with the concatenated data payload. It stops early when onData returns
// false, which happens when the client has gone away.
func scanSSE(upstream io.Reader, onData func(payload []byte) bool) error {
	reader := bufio.NewReaderSize(upstream, 64<<10)
	var payload []byte

	flush := func() bool {
		if len(payload) == 0 {
			return true
		}
		data := payload
		payload = nil
		if bytes.Equal(bytes.TrimSpace(data), []byte("[DONE]")) {
			return true
		}
		return onData(data)
	}

	for {
		line, err := readSSELine(reader)
		if len(line) > 0 || err == nil {
			trimmed := bytes.TrimRight(line, "\r")
			switch {
			case len(trimmed) == 0:
				if !flush() {
					return nil
				}
			case bytes.HasPrefix(trimmed, []byte("data:")):
				value := bytes.TrimPrefix(trimmed, []byte("data:"))
				value = bytes.TrimPrefix(value, []byte(" "))
				if len(payload) > 0 {
					payload = append(payload, '\n')
				}
				payload = append(payload, value...)
			default:
				// event:, id: and comment lines carry no data the
				// translator needs; the payload's own type field is used.
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if !flush() {
					return nil
				}
				return nil
			}
			return err
		}
	}
}

// readSSELine reads one line without the trailing newline, joining the pieces
// of a line longer than the reader's buffer.
func readSSELine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		if len(line)+len(chunk) > sseReadLimit {
			return nil, errors.New("sse: event line exceeds limit")
		}
		line = append(line, chunk...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil {
			return bytes.TrimSuffix(line, []byte("\n")), err
		}
		return bytes.TrimSuffix(line, []byte("\n")), nil
	}
}
