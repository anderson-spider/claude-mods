//go:build !contract

package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// In the default build the CCMPROXY_CONTRACT_* variables reach nothing a
// Router does: New keeps the 10 s keepalive and sends upstream traffic only
// to cfg.Upstream.
func TestContractVariablesDoNotReachTheRouter(t *testing.T) {
	var decoyHits atomic.Int32
	decoy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		decoyHits.Add(1)
		w.WriteHeader(http.StatusTeapot)
	}))
	t.Cleanup(decoy.Close)

	for name, value := range map[string]string{
		"CCMPROXY_CONTRACT_UPSTREAM":        decoy.URL,
		"CCMPROXY_CONTRACT_CODEX_BASE_URL":  decoy.URL,
		"CCMPROXY_CONTRACT_OAUTH_AUTH_URL":  decoy.URL + "/authorize",
		"CCMPROXY_CONTRACT_OAUTH_TOKEN_URL": decoy.URL + "/token",
		"CCMPROXY_CONTRACT_CA_FILE":         "/nonexistent/ca.pem",
		"CCMPROXY_CONTRACT_PING_INTERVAL":   "20ms",
	} {
		t.Setenv(name, value)
	}

	// A stream that stays silent for well over the variable's interval.
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, `{"type":"response.created","response":{"id":"resp_inert","model":"gpt-6-luna"}}`)
		time.Sleep(200 * time.Millisecond)
		writeSSE(w, `{"type":"response.output_text.delta","delta":"Hi"}`)
		writeSSE(w, `{"type":"response.completed","response":{"id":"resp_inert","usage":{}}}`)
	}, true)

	if got := h.router.pingInterval; got != defaultPingInterval {
		t.Fatalf("New's ping interval = %v, want %v", got, defaultPingInterval)
	}
	rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "event: message_stop") {
		t.Fatalf("stream = %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "event: ping") {
		t.Fatalf("a ping went out within 200 ms:\n%s", rec.Body.String())
	}

	for _, target := range []string{"/v1/models", "/v1/complete"} {
		h.reset()
		method, body := http.MethodGet, ""
		if target == "/v1/complete" {
			method, body = http.MethodPost, `{}`
		}
		if rec := h.do(t, method, target, body); rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", target, rec.Code)
		}
		if h.anthropic.path != target {
			t.Fatalf("%s: cfg.Upstream saw %q", target, h.anthropic.path)
		}
	}
	h.reset()
	h.do(t, http.MethodPost, "/v1/messages", `{"model":"claude-opus-5","messages":[]}`)
	if h.anthropic.path != "/v1/messages" {
		t.Fatalf("messages: cfg.Upstream saw %q", h.anthropic.path)
	}
	if n := decoyHits.Load(); n != 0 {
		t.Fatalf("the variables' upstream got %d request(s)", n)
	}
}
