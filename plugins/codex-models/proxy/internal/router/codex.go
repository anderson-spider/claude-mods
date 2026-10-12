package router

import (
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/tokenize"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/translate"
)

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
// metadata.user_id. One id per Claude Code session keeps a conversation on
// one upstream session, but the raw value carries Anthropic account and
// device identifiers, so only an HMAC-SHA256 of it keyed with the install's
// session_salt is sent: stable for the same input, meaningless without the
// salt. It is shaped as a version 4 UUID, like the ids the Codex CLI sends.
// Without a user_id the id is random.
func codexSessionID(salt, userID string) string {
	if userID == "" {
		return codex.NewSessionID()
	}
	mac := hmac.New(sha256.New, []byte(salt))
	mac.Write([]byte(userID))
	id := mac.Sum(nil)[:16]
	id[6] = id[6]&0x0f | 0x40 // version 4
	id[8] = id[8]&0x3f | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

// serveCodexMessages answers a Messages request from the Codex backend.
// effort comes from resolveEffort, so the value logged by the caller and the
// value sent are the same one.
func (r *Router) serveCodexMessages(w http.ResponseWriter, req *http.Request, body []byte, head messagesHead,
	resolution codex.Resolution, effort string) {
	if r.backend == nil {
		writeAnthropicError(w, http.StatusServiceUnavailable, "api_error", "the Codex backend is not configured")
		return
	}
	if logx.Enabled(logx.LevelDebug) {
		logx.Debugf("codex effort: model name=%q client=%q -> %q (supported: %s)",
			resolution.Effort, head.clientEffort(), effort, strings.Join(resolution.Model.ReasoningLevel, ","))
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

	resp, err := r.backend.Responses(req.Context(), translated.Body, codexSessionID(r.cfg.SessionSalt, head.userID()))
	if err != nil {
		writeCodexError(w, err)
		return
	}
	defer func() { _ = resp.Body.Close() }()

	if head.Stream {
		r.streamCodex(w, req, resp.Body, resolution.Model.ID, translated.ToolNames)
		return
	}
	bufferCodex(w, resp.Body, resolution.Model.ID, translated.ToolNames)
}

// streamCodex relays the backend's event stream as Anthropic SSE.
func (r *Router) streamCodex(w http.ResponseWriter, req *http.Request, upstream io.Reader, model string, toolNames map[string]string) {
	header := w.Header()
	header.Set("Content-Type", "text/event-stream; charset=utf-8")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	// A buffering proxy in between would defeat the point of streaming.
	header.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	controller := http.NewResponseController(w)
	_ = controller.Flush()

	translator := translate.NewStreamTranslator(model, toolNames)
	out := newSSEWriter(req.Context(), w, controller.Flush, r.pingInterval)
	defer out.close()
	// The message is open between message_start and its end or an error;
	// only then may a ping go out.
	send := func(frames []byte) bool {
		return out.write(frames, translator.Started() && !translator.Ended())
	}

	err := scanSSE(upstream, func(payload []byte) bool {
		return send(translator.Event(payload))
	})
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, req.Context().Err()) {
		logx.Warnf("codex stream: upstream read failed: %v", err)
		send(translator.Error("api_error", "upstream stream ended: "+err.Error()))
	}
	// Close ends the message, or reports a stream that stopped before its
	// terminal event as an error; it never invents a successful ending.
	send(translator.Close())
}

// bufferCodex answers a client that did not ask for streaming. The Codex
// backend only streams, so the events go through the same translator as the
// streaming path and are then folded into one message.
func bufferCodex(w http.ResponseWriter, upstream io.Reader, model string, toolNames map[string]string) {
	translator := translate.NewStreamTranslator(model, toolNames)
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

// tokenCount is the body of a count_tokens answer.
type tokenCount struct {
	InputTokens int64 `json:"input_tokens"`
}

// writeCodexTokenCount answers count_tokens for a Codex model with a local
// estimate, since the backend has no counting endpoint.
func (r *Router) writeCodexTokenCount(w http.ResponseWriter, body []byte) {
	writeJSON(w, http.StatusOK, tokenCount{InputTokens: tokenize.EstimateClaudeRequest(body)})
}
