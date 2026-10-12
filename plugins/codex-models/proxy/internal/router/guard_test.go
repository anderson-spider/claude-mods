package router

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jclab-joseph/claude-code-model-proxy/internal/config"
)

const (
	guardToken  = "f00dfacef00dfacef00dfacef00dfacef00dfacef00dfacef00dfacef00dface"
	guardListen = "127.0.0.1:8081"
)

// guarded wraps the harness router in Guard, listening on listen.
func guarded(t *testing.T, h *harness, listen string) http.Handler {
	t.Helper()
	h.router.cfg.AuthToken = guardToken
	h.router.cfg.ListenHTTP = listen
	handler, err := Guard(h.router.cfg, h.router)
	if err != nil {
		t.Fatalf("Guard: %v", err)
	}
	return handler
}

// reset forgets what the fake upstreams saw.
func (h *harness) reset() {
	*h.anthropic = recorded{}
	*h.codex = recorded{}
}

func (h *harness) reachedUpstream() bool {
	return h.anthropic.method != "" || h.codex.method != ""
}

type sent struct {
	method, target, host string
	body                 []byte
	header               http.Header
}

func serve(handler http.Handler, s sent) *httptest.ResponseRecorder {
	var body io.Reader
	if s.body != nil {
		body = bytes.NewReader(s.body)
	}
	req := httptest.NewRequest(s.method, s.target, body)
	req.Host = guardListen
	if s.host != "" {
		req.Host = s.host
	}
	for name, values := range s.header {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func assertNoCORS(t *testing.T, label string, rec *httptest.ResponseRecorder) {
	t.Helper()
	for name := range rec.Header() {
		if strings.HasPrefix(strings.ToLower(name), "access-control-") {
			t.Fatalf("%s: response carries %s", label, name)
		}
	}
}

func assertForbidden(t *testing.T, label string, rec *httptest.ResponseRecorder, method string) {
	t.Helper()
	if rec.Code != http.StatusForbidden {
		t.Fatalf("%s: status = %d, want 403", label, rec.Code)
	}
	if method == http.MethodHead {
		return
	}
	var payload struct {
		Type  string `json:"type"`
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("%s: body %q is not JSON: %v", label, rec.Body.String(), err)
	}
	if payload.Type != "error" || payload.Error.Type != "permission_error" || !strings.HasPrefix(payload.Error.Message, "ccmproxy: ") {
		t.Fatalf("%s: body = %s, want an Anthropic permission_error", label, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), guardToken) {
		t.Fatalf("%s: the refusal repeats the secret", label)
	}
}

func TestGuardNeedsAToken(t *testing.T) {
	cfg := config.Default()
	if _, err := Guard(cfg, http.NotFoundHandler()); err == nil {
		t.Fatal("Guard without auth_token must refuse to build")
	}
}

func TestEveryMethodAndPathNeedsTheSecret(t *testing.T) {
	h := newHarness(t, nil, nil, true)
	handler := guarded(t, h, guardListen)

	methods := []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodHead, http.MethodOptions}
	paths := []string{"/v1/messages", "/v1/messages/count_tokens", "/v1/models", "/__ccmproxy/status", "/v1/unknown", "/api/hello"}
	secrets := map[string][]string{
		"none":       nil,
		"empty":      {""},
		"wrong":      {"0" + guardToken[1:]},
		"prefix":     {guardToken[:32]},
		"longer":     {guardToken + "0"},
		"padded":     {" " + guardToken},
		"two values": {guardToken, "other"},
	}

	for _, method := range methods {
		for _, path := range paths {
			var body []byte
			if method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch {
				body = []byte(`{"model":"claude-sonnet-4-5","messages":[]}`)
			}

			for name, values := range secrets {
				if method == http.MethodHead && path == helloPath {
					continue // the probe; see TestHelloProbeIsAnsweredLocally
				}
				label := method + " " + path + " secret=" + name
				h.reset()
				header := http.Header{"Content-Type": {"application/json"}}
				for _, value := range values {
					header.Add(config.TokenHeader, value)
				}
				rec := serve(handler, sent{method: method, target: path, body: body, header: header})
				assertForbidden(t, label, rec, method)
				assertNoCORS(t, label, rec)
				if h.reachedUpstream() {
					t.Fatalf("%s: a refused request reached an upstream", label)
				}
			}

			label := method + " " + path + " secret=right"
			h.reset()
			rec := serve(handler, sent{method: method, target: path, body: body, header: http.Header{
				"Content-Type":     {"application/json"},
				config.TokenHeader: {guardToken},
			}})
			assertNoCORS(t, label, rec)
			if method == http.MethodOptions {
				assertForbidden(t, label, rec, method)
				if h.reachedUpstream() {
					t.Fatalf("%s: OPTIONS reached an upstream", label)
				}
				continue
			}
			if rec.Code == http.StatusForbidden {
				t.Fatalf("%s: status 403 with the right secret: %s", label, rec.Body.String())
			}
		}
	}
}

func TestHelloProbeIsAnsweredLocally(t *testing.T) {
	h := newHarness(t, nil, nil, true)
	handler := guarded(t, h, guardListen)

	for _, header := range []http.Header{nil, {config.TokenHeader: {"wrong"}}, {config.TokenHeader: {guardToken}}} {
		h.reset()
		rec := serve(handler, sent{method: http.MethodHead, target: "/api/hello", header: header})
		if rec.Code != http.StatusOK {
			t.Fatalf("HEAD /api/hello = %d, want 200", rec.Code)
		}
		if rec.Body.Len() != 0 {
			t.Fatalf("HEAD /api/hello body = %q", rec.Body.String())
		}
		if h.reachedUpstream() {
			t.Fatal("HEAD /api/hello reached an upstream")
		}
		assertNoCORS(t, "HEAD /api/hello", rec)
	}

	// Only the HEAD probe is exempt.
	h.reset()
	rec := serve(handler, sent{method: http.MethodGet, target: "/api/hello"})
	assertForbidden(t, "GET /api/hello", rec, http.MethodGet)
	if h.reachedUpstream() {
		t.Fatal("GET /api/hello without the secret reached an upstream")
	}
}

func TestOptionsIsRefusedWithoutCORS(t *testing.T) {
	h := newHarness(t, nil, nil, true)
	handler := guarded(t, h, guardListen)

	rec := serve(handler, sent{method: http.MethodOptions, target: "/v1/messages", header: http.Header{
		"Origin":                         {"https://evil.test"},
		"Access-Control-Request-Method":  {"POST"},
		"Access-Control-Request-Headers": {"x-ccmproxy-token, content-type"},
	}})
	assertForbidden(t, "preflight", rec, http.MethodOptions)
	assertNoCORS(t, "preflight", rec)
	if h.reachedUpstream() {
		t.Fatal("a preflight reached an upstream")
	}
}

func TestHostMustNameTheListener(t *testing.T) {
	cases := []struct {
		listen string
		host   string
		ok     bool
	}{
		{"127.0.0.1:8081", "127.0.0.1:8081", true},
		{"127.0.0.1:8081", "localhost:8081", true},
		{"127.0.0.1:8081", "LOCALHOST:8081", true},
		{"127.0.0.1:8081", "127.0.0.1:9999", false},
		{"127.0.0.1:8081", "127.0.0.1", false},
		{"127.0.0.1:8081", "localhost", false},
		{"127.0.0.1:8081", "[::1]:8081", false},
		{"127.0.0.1:8081", "127.0.0.2:8081", false},
		{"127.0.0.1:8081", "evil.test", false},
		{"127.0.0.1:8081", "evil.test:8081", false},
		{"127.0.0.1:8081", "api.anthropic.com", false},
		{"127.0.0.2:8081", "127.0.0.2:8081", true},
		{"127.0.0.2:8081", "localhost:8081", false},
		{"[::1]:8081", "[::1]:8081", true},
		{"[::1]:8081", "localhost:8081", false},
		{"127.0.0.1:80", "127.0.0.1", true},
		{"127.0.0.1:80", "localhost", true},
	}
	for _, tc := range cases {
		h := newHarness(t, nil, nil, true)
		handler := guarded(t, h, tc.listen)
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			target := "/v1/models"
			if method == http.MethodHead {
				target = "/api/hello"
			}
			h.reset()
			rec := serve(handler, sent{method: method, target: target, host: tc.host, header: http.Header{config.TokenHeader: {guardToken}}})
			label := method + " listen=" + tc.listen + " Host=" + tc.host
			if tc.ok && rec.Code == http.StatusForbidden {
				t.Fatalf("%s: refused, want accepted", label)
			}
			if !tc.ok {
				assertForbidden(t, label, rec, method)
				if h.reachedUpstream() {
					t.Fatalf("%s: reached an upstream", label)
				}
			}
		}
	}
}

func TestAnAbsoluteFormRequestForAnotherHostIsRefused(t *testing.T) {
	h := newHarness(t, nil, nil, true)
	handler := guarded(t, h, guardListen)
	req := httptest.NewRequest(http.MethodGet, "http://evil.test/v1/models", nil)
	req.Header.Set(config.TokenHeader, guardToken)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertForbidden(t, "absolute-form", rec, http.MethodGet)
	if h.reachedUpstream() {
		t.Fatal("reached an upstream")
	}
}

// passthroughHeaders are the client headers that must reach Anthropic as
// they were sent.
var passthroughHeaders = http.Header{
	"Authorization":           {"Bearer sk-ant-oat01-test"},
	"Anthropic-Beta":          {"oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14"},
	"Anthropic-Version":       {"2023-06-01"},
	"X-App":                   {"cli"},
	"X-Claude-Code-Agent-Id":  {"agent-7f3a"},
	"X-Stainless-Retry-Count": {"0"},
	"User-Agent":              {"claude-cli/2.1.300 (external, cli)"},
	"Anthropic-Dangerous-Direct-Browser-Access": {"true"},
}

func gzipped(t *testing.T, data string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(data)); err != nil {
		t.Fatalf("gzip: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip: %v", err)
	}
	return buf.Bytes()
}

func TestPassthroughKeepsEveryHeaderButTheSecret(t *testing.T) {
	claudeBody := `{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`
	routes := []struct {
		name     string
		method   string
		target   string
		body     []byte
		encoding string
		path     string
	}{
		{"messages", http.MethodPost, "/v1/messages?beta=true", []byte(claudeBody), "", "/v1/messages"},
		{"compressed messages", http.MethodPost, "/v1/messages?beta=true", gzipped(t, claudeBody), "gzip", "/v1/messages"},
		{"count_tokens", http.MethodPost, "/v1/messages/count_tokens?beta=true", []byte(claudeBody), "", "/v1/messages/count_tokens"},
		{"models", http.MethodGet, "/v1/models", nil, "", "/v1/models"},
		{"models page", http.MethodGet, "/v1/models?after_id=claude-x", nil, "", "/v1/models"},
		{"bootstrap", http.MethodGet, "/api/claude_cli/bootstrap", nil, "", "/api/claude_cli/bootstrap"},
		{"unknown", http.MethodPost, "/v1/complete", []byte(`{"prompt":"x"}`), "", "/v1/complete"},
	}

	for _, route := range routes {
		h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			_, _ = w.Write([]byte(`{"data":[]}`))
		}, nil, true)
		handler := guarded(t, h, guardListen)

		header := passthroughHeaders.Clone()
		header.Set(config.TokenHeader, guardToken)
		header.Set("Content-Type", "application/json")
		if route.encoding != "" {
			header.Set("Content-Encoding", route.encoding)
		}
		rec := serve(handler, sent{method: route.method, target: route.target, body: route.body, header: header})
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d: %s", route.name, rec.Code, rec.Body.String())
		}
		assertNoCORS(t, route.name, rec)

		got := h.anthropic
		if got.path != route.path {
			t.Fatalf("%s: upstream path = %q", route.name, got.path)
		}
		for name, values := range passthroughHeaders {
			if strings.Join(got.header.Values(name), "\n") != strings.Join(values, "\n") {
				t.Fatalf("%s: %s = %q, want %q", route.name, name, got.header.Values(name), values)
			}
		}
		if route.encoding != "" && got.header.Get("Content-Encoding") != route.encoding {
			t.Fatalf("%s: Content-Encoding = %q", route.name, got.header.Get("Content-Encoding"))
		}
		assertSecretAbsent(t, route.name, got.header)
		if route.body != nil && got.body != string(route.body) {
			t.Fatalf("%s: upstream body differs from what was sent", route.name)
		}
	}
}

func TestTheSecretNeverReachesTheCodexBackend(t *testing.T) {
	h := newHarness(t, nil, nil, true)
	handler := guarded(t, h, guardListen)

	header := passthroughHeaders.Clone()
	header.Set(config.TokenHeader, guardToken)
	header.Set("Content-Type", "application/json")
	rec := serve(handler, sent{method: http.MethodPost, target: "/v1/messages", header: header,
		body: []byte(`{"model":"gpt-5.5","stream":true,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`)})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if h.codex.method == "" {
		t.Fatal("the Codex backend was not reached")
	}
	assertSecretAbsent(t, "codex", h.codex.header)
	if h.anthropic.method != "" {
		t.Fatal("a Codex request reached Anthropic")
	}
}

func TestRouterDropsTheSecretEvenWithoutTheGuard(t *testing.T) {
	// The backstop: a request that reaches the router with the header still
	// on it (no Guard in front) must not carry it upstream.
	for _, target := range []string{"/v1/models", "/v1/complete"} {
		h := newHarness(t, nil, nil, true)
		method := http.MethodGet
		var body []byte
		if target == "/v1/complete" {
			method, body = http.MethodPost, []byte(`{}`)
		}
		rec := serve(h.router, sent{method: method, target: target, body: body, header: http.Header{config.TokenHeader: {guardToken}}})
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", target, rec.Code)
		}
		assertSecretAbsent(t, target, h.anthropic.header)
	}
}

func assertSecretAbsent(t *testing.T, label string, header http.Header) {
	t.Helper()
	if len(header.Values(config.TokenHeader)) != 0 {
		t.Fatalf("%s: %s reached the upstream", label, config.TokenHeader)
	}
	for name, values := range header {
		for _, value := range values {
			if strings.Contains(value, guardToken) {
				t.Fatalf("%s: the secret reached the upstream in %s", label, name)
			}
		}
	}
}

func TestStatusShape(t *testing.T) {
	for _, loggedIn := range []bool{true, false} {
		h := newHarness(t, nil, nil, loggedIn)
		h.router.Version = "1.2.3"
		handler := guarded(t, h, guardListen)

		rec := serve(handler, sent{method: http.MethodGet, target: "/__ccmproxy/status", header: http.Header{config.TokenHeader: {guardToken}}})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Fatalf("Content-Type = %q", ct)
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
			t.Fatalf("body %q: %v", rec.Body.String(), err)
		}
		if len(raw) != 4 {
			t.Fatalf("keys = %v, want exactly service, version, codexLogin, models", raw)
		}
		var status struct {
			Service    string   `json:"service"`
			Version    string   `json:"version"`
			CodexLogin *bool    `json:"codexLogin"`
			Models     []string `json:"models"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if status.Service != "ccmproxy" || status.Version != "1.2.3" || status.CodexLogin == nil || *status.CodexLogin != loggedIn {
			t.Fatalf("status = %s", rec.Body.String())
		}
		if strings.Join(status.Models, ",") != strings.Join(h.router.registry.AdvertisedIDs(), ",") || len(status.Models) == 0 {
			t.Fatalf("models = %v", status.Models)
		}
		for _, leak := range []string{"user@example.com", h.router.cfg.AuthDir, guardToken, "acct_test"} {
			if strings.Contains(rec.Body.String(), leak) {
				t.Fatalf("status leaks %q", leak)
			}
		}
		if h.reachedUpstream() {
			t.Fatal("status reached an upstream")
		}

		rec = serve(handler, sent{method: http.MethodPost, target: "/__ccmproxy/status", body: []byte(`{}`), header: http.Header{config.TokenHeader: {guardToken}}})
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("POST status = %d, want 405", rec.Code)
		}
	}
}

func TestStatusReportsDevWithoutAVersion(t *testing.T) {
	h := newHarness(t, nil, nil, false)
	handler := guarded(t, h, guardListen)
	rec := serve(handler, sent{method: http.MethodGet, target: "/__ccmproxy/status", header: http.Header{config.TokenHeader: {guardToken}}})
	if !strings.Contains(rec.Body.String(), `"version":"dev"`) {
		t.Fatalf("status = %s", rec.Body.String())
	}
}

func TestConnectAndTraceAreRefusedEvenWithTheSecret(t *testing.T) {
	h := newHarness(t, nil, nil, true)
	handler := guarded(t, h, guardListen)
	for _, method := range []string{http.MethodConnect, http.MethodTrace} {
		for _, path := range []string{"/v1/messages", "/v1/models", "/__ccmproxy/status", "/api/hello"} {
			h.reset()
			rec := serve(handler, sent{method: method, target: path, header: http.Header{config.TokenHeader: {guardToken}}})
			label := method + " " + path
			assertForbidden(t, label, rec, method)
			assertNoCORS(t, label, rec)
			if h.reachedUpstream() {
				t.Fatalf("%s reached an upstream", label)
			}
		}
	}
}
