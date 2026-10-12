package router

import (
	"encoding/json"
	"net/http"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// serveMessages routes a Messages request to the Codex backend or to
// Anthropic, by the model its body names.
func (r *Router) serveMessages(w http.ResponseWriter, req *http.Request) {
	body, err := readBody(req)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}
	if refuseInvalidJSON(w, body) {
		return
	}

	head := readHead(body.JSON)
	model := string(head.Model)
	resolution, isCodex := r.registry.Resolve(model)
	if !isCodex {
		if model == "" && body.Compressed() && !body.Readable() {
			// Worth saying out loud: an unreadable body is why a request for
			// an added model would silently go to Anthropic instead.
			logx.Warnf("could not read the model from a %s encoded body; routing to %s", body.Encoding, r.cfg.Upstream)
		}
		if forwardUpstream(req, body) {
			logx.Debugf("dropped proxy-issued thinking blocks before passing %s upstream", model)
		}
		logx.Debugf("passthrough messages model=%s", model)
		r.proxy.ServeHTTP(w, req)
		return
	}

	effort := resolveEffort(body.JSON, resolution)
	logx.Infof("codex messages model=%s -> %s effort=%s (%s body)",
		model, resolution.Model.ID, effort, encodingLabel(body))
	r.serveCodexMessages(w, req, body.JSON, head, resolution, effort)
}

// serveCountTokens answers a token count for a Codex model locally and lets
// Anthropic answer for its own.
func (r *Router) serveCountTokens(w http.ResponseWriter, req *http.Request) {
	body, err := readBody(req)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}
	if refuseInvalidJSON(w, body) {
		return
	}

	if _, isCodex := r.registry.Resolve(string(readHead(body.JSON).Model)); !isCodex {
		forwardUpstream(req, body)
		r.proxy.ServeHTTP(w, req)
		return
	}
	r.writeCodexTokenCount(w, body.JSON)
}

// refuseInvalidJSON answers 400 for a body the proxy can read and knows is
// not valid JSON, and reports whether it did. No upstream can serve such a
// body, and forwarding it could send a prompt meant for Codex to Anthropic.
// A body under a coding the proxy cannot undo is not judged: it goes
// upstream as it came.
func refuseInvalidJSON(w http.ResponseWriter, body *requestBody) bool {
	if !body.Readable() || json.Valid(body.JSON) {
		return false
	}
	writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "ccmproxy: request body is not valid JSON")
	return true
}

// forwardUpstream puts the body back on a request bound for Anthropic and
// reports whether it had to be rewritten. Reasoning state this proxy issued
// for a Codex turn would be refused by Anthropic, so it is dropped when a
// session switches back to a Claude model. Otherwise the bytes go out as the
// client sent them, under their content coding; the signature filter drops the blocks
// without re-encoding the rest.
func forwardUpstream(req *http.Request, body *requestBody) bool {
	cleaned, changed := StripProxySignatures(body.JSON)
	if !changed {
		body.forward(req)
		return false
	}
	body.forwardModified(req, cleaned)
	return true
}

// encodingLabel describes how the client sent the body, which decides
// whether the model could be read at all.
func encodingLabel(body *requestBody) string {
	if !body.Compressed() {
		return "identity"
	}
	return body.Encoding
}
