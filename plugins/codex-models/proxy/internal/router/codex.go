package router

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/tokenize"
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
		effort = effortFrom(body, resolution.Model.DefaultEffort)
	}
	return resolution.Model.ClampEffort(effort)
}

// codexSessionID derives the remote metadata.user_id from Claude Code's
// metadata.user_id. One id per Claude Code session keeps a conversation on
// one upstream session, but the raw value carries Anthropic account and
// device identifiers, so only an HMAC-SHA256 of it keyed with the install's
// session_salt is sent: stable for the same input, meaningless without the
// salt. It is shaped as a version 4 UUID, like the ids the Codex CLI sends.
// Without a user_id the id is random.
func codexSessionID(salt, userID string) string {
	if userID == "" {
		var raw [16]byte
		_, _ = rand.Read(raw[:])
		raw[6] = raw[6]&0x0f | 0x40
		raw[8] = raw[8]&0x3f | 0x80
		return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
	}
	mac := hmac.New(sha256.New, []byte(salt))
	mac.Write([]byte(userID))
	id := mac.Sum(nil)[:16]
	id[6] = id[6]&0x0f | 0x40 // version 4
	id[8] = id[8]&0x3f | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

// serveCodexMessages forwards a Messages body, not a Responses translation.
func (r *Router) serveCodexMessages(w http.ResponseWriter, req *http.Request, body []byte, head messagesHead, resolution codex.Resolution, effort string) {
	if r.backend == nil {
		writeAnthropicError(w, 503, "api_error", codex.ErrUnreachable.Error())
		return
	}
	body = remoteRequest(body, resolution.Model.ID+"("+effort+")", codexSessionID(r.cfg.SessionSalt, head.userID()))
	resp, err := r.backend.Messages(req.Context(), body, req.Header)
	if err != nil {
		writeCodexError(w, err)
		return
	}
	defer resp.Body.Close()
	if head.Stream {
		r.streamCodex(w, req, resp.Body)
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxRequestBody+1))
	if err != nil || len(data) > maxRequestBody {
		if err != nil && req.Context().Err() == nil {
			r.backend.ClearLimits()
		}
		writeAnthropicError(w, 502, "api_error", "ccmproxy: Codex remote answer could not be read")
		return
	}
	data, typ, err := markAnswer(data)
	if err != nil {
		writeAnthropicError(w, 502, "api_error", "ccmproxy: invalid Codex remote answer")
		return
	}
	status := http.StatusOK
	if typ == "error" {
		status = errorTypeStatus(lookupText(data, "error", "type"))
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

// tokenCount is the body of a count_tokens answer.
type tokenCount struct {
	InputTokens int64 `json:"input_tokens"`
}

// writeCodexTokenCount answers count_tokens for a Codex model with a local
// estimate, because the remote count underestimates.
func (r *Router) writeCodexTokenCount(w http.ResponseWriter, body []byte) {
	writeJSON(w, http.StatusOK, tokenCount{InputTokens: tokenize.EstimateClaudeRequest(body)})
}
