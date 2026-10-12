package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
)

// Guard takes the secret off the request before anything behind it runs, so
// no outbound path can copy it, whatever that path forwards.
func TestGuardRemovesTheSecretBeforeTheHandler(t *testing.T) {
	cfg := config.Default()
	cfg.AuthToken = guardToken
	cfg.ListenHTTP = guardListen

	var reached int
	var seen []string
	handler, err := Guard(cfg, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		reached++
		seen = append(seen, req.Header.Values(config.TokenHeader)...)
		w.WriteHeader(http.StatusOK)
	}))
	if err != nil {
		t.Fatalf("Guard: %v", err)
	}

	for _, header := range []http.Header{
		{config.TokenHeader: {guardToken}},
		{"x-ccmproxy-token": {guardToken}},
	} {
		rec := serve(handler, sent{method: http.MethodGet, target: "/v1/models", header: header})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
		}
	}
	if reached != 2 {
		t.Fatalf("the handler ran %d times, want 2", reached)
	}
	if len(seen) != 0 {
		t.Fatalf("the handler saw %s = %q", config.TokenHeader, seen)
	}

	// Refused requests carrying the secret reach nothing either.
	for _, s := range []sent{
		{method: http.MethodOptions, target: "/v1/messages"},
		{method: http.MethodGet, target: "/v1/models", host: "evil.test"},
	} {
		s.header = http.Header{config.TokenHeader: {guardToken}}
		if rec := serve(handler, s); rec.Code != http.StatusForbidden {
			t.Fatalf("%s Host=%q: status = %d, want 403", s.method, s.host, rec.Code)
		}
	}
	if reached != 2 {
		t.Fatalf("a refused request reached the handler (%d runs)", reached)
	}
}

// The request the guard refuses has the secret taken off too, before the
// Host and method checks run.
func TestGuardRemovesTheSecretFromARefusedRequest(t *testing.T) {
	cfg := config.Default()
	cfg.AuthToken = guardToken
	cfg.ListenHTTP = guardListen
	handler, err := Guard(cfg, http.NotFoundHandler())
	if err != nil {
		t.Fatalf("Guard: %v", err)
	}
	for _, s := range []sent{
		{method: http.MethodOptions, target: "/v1/messages"},
		{method: http.MethodGet, target: "/v1/models", host: "evil.test"},
	} {
		req := httptest.NewRequest(s.method, s.target, nil)
		req.Host = guardListen
		if s.host != "" {
			req.Host = s.host
		}
		req.Header.Set(config.TokenHeader, guardToken)
		handler.ServeHTTP(httptest.NewRecorder(), req)
		if got := req.Header.Values(config.TokenHeader); len(got) != 0 {
			t.Fatalf("%s Host=%q: the refused request still carries %q", s.method, s.host, got)
		}
	}
}
