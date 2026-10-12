package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// upstreamHits counts the requests a fake server received and the Authorization
// values it saw.
type upstreamHits struct {
	mu    sync.Mutex
	paths map[string]int
	auth  []string
	keys  []string
}

func (h *upstreamHits) reset() {
	h.mu.Lock()
	h.paths = map[string]int{}
	h.auth = nil
	h.keys = nil
	h.mu.Unlock()
}

func (h *upstreamHits) record(r *http.Request) {
	h.mu.Lock()
	h.paths[r.URL.Path]++
	if v := r.Header.Get("Authorization"); v != "" {
		h.auth = append(h.auth, v)
	}
	if v := r.Header.Get("x-api-key"); v != "" {
		h.keys = append(h.keys, v)
	}
	h.mu.Unlock()
}

func (h *upstreamHits) total() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, c := range h.paths {
		n += c
	}
	return n
}

const clientBearer = "Bearer sk-ant-oat-REDIRECT-TEST-BEARER"

// TestRedirectsToAnotherHostAreNeverFollowed sends every intercepted and
// pass-through route to an upstream that answers each 3xx status with a
// Location on another host. The other host must see nothing, the upstream
// exactly one request, and the client the 3xx with the same Location.
func TestRedirectsToAnotherHostAreNeverFollowed(t *testing.T) {
	target := &upstreamHits{}
	target.reset()
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target.record(r)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[],"stolen":true}`))
	}))
	defer elsewhere.Close()

	for _, status := range []int{http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		for _, authenticated := range []bool{false, true} {
			upstream := &upstreamHits{}
			upstream.reset()
			location := elsewhere.URL + "/steal?x=1"
			h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
				upstream.record(r)
				w.Header().Set("Location", location)
				w.WriteHeader(status)
			}, nil, authenticated)

			for _, tc := range []struct{ method, target, body, path string }{
				{http.MethodGet, "/v1/models", "", "/v1/models"},
				{http.MethodGet, "/v1/models/", "", "/v1/models/"},
				{http.MethodGet, "/v1/models?after_id=x", "", "/v1/models"},
				{http.MethodGet, "/v1/models?before_id=y&limit=5", "", "/v1/models"},
				{http.MethodGet, "/v1/models/claude-opus-5", "", "/v1/models/claude-opus-5"},
				{http.MethodPost, "/v1/messages", `{"model":"claude-opus-5","messages":[]}`, "/v1/messages"},
				{http.MethodPost, "/v1/messages", `{"model":"claude-opus-5","stream":true,"messages":[]}`, "/v1/messages"},
				{http.MethodPost, "/v1/messages/count_tokens", `{"model":"claude-opus-5","messages":[]}`, "/v1/messages/count_tokens"},
				{http.MethodPost, "/v1/complete", `{}`, "/v1/complete"},
				{http.MethodGet, "/api/claude_cli/bootstrap", "", "/api/claude_cli/bootstrap"},
			} {
				upstream.reset()
				target.reset()
				var reader *strings.Reader
				if tc.body != "" {
					reader = strings.NewReader(tc.body)
				} else {
					reader = strings.NewReader("")
				}
				req := httptest.NewRequest(tc.method, tc.target, reader)
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("anthropic-version", "2023-06-01")
				req.Header.Set("Authorization", clientBearer)
				rec := httptest.NewRecorder()
				h.router.ServeHTTP(rec, req)

				name := tc.method + " " + tc.target
				if n := target.total(); n != 0 {
					t.Fatalf("%d auth=%v %s: the redirect target got %d request(s), auth %v", status, authenticated, name, n, target.auth)
				}
				upstream.mu.Lock()
				hits := upstream.paths[tc.path]
				all := len(upstream.paths)
				sawAuth := append([]string(nil), upstream.auth...)
				upstream.mu.Unlock()
				if hits != 1 || all != 1 {
					t.Fatalf("%d auth=%v %s: upstream hits %v, want exactly one", status, authenticated, name, upstream.paths)
				}
				if len(sawAuth) != 1 || sawAuth[0] != clientBearer {
					t.Fatalf("%d auth=%v %s: upstream Authorization %v, want the client's once", status, authenticated, name, sawAuth)
				}
				// The model list falls back to the added models when the
				// Codex login is usable; otherwise the 3xx goes back as is.
				modelList := tc.method == http.MethodGet && (tc.target == "/v1/models" || tc.target == "/v1/models/" ||
					strings.HasPrefix(tc.target, "/v1/models?"))
				if modelList && authenticated {
					if rec.Code != http.StatusOK {
						t.Fatalf("%d %s: authenticated list = %d", status, name, rec.Code)
					}
					if strings.Contains(rec.Body.String(), "stolen") {
						t.Fatalf("%d %s: the list carries the redirect target's body", status, name)
					}
					continue
				}
				if rec.Code != status || rec.Header().Get("Location") != location {
					t.Fatalf("%d auth=%v %s: got %d Location %q, want %d %q", status, authenticated, name, rec.Code, rec.Header().Get("Location"), status, location)
				}
				if strings.Contains(rec.Body.String(), "stolen") {
					t.Fatalf("%d %s: the body came from the redirect target", status, name)
				}
			}
		}
	}
}

// TestCodexBackendRedirectsToAnotherHostAreNeverFollowed: the Codex backend carries the
// ChatGPT bearer; a 3xx from it must not reach the Location and must not
// become a 401 toward Claude Code.
func TestCodexBackendRedirectsToAnotherHostAreNeverFollowed(t *testing.T) {
	target := &upstreamHits{}
	target.reset()
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target.record(r)
		w.WriteHeader(http.StatusOK)
	}))
	defer elsewhere.Close()

	for _, status := range []int{301, 302, 303, 307, 308} {
		backend := &upstreamHits{}
		backend.reset()
		h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
			backend.record(r)
			w.Header().Set("Location", elsewhere.URL+"/steal")
			w.WriteHeader(status)
		}, true)
		for _, body := range []string{
			`{"model":"gpt-6-luna","messages":[{"role":"user","content":"hi"}]}`,
			`{"model":"gpt-6-luna","stream":true,"messages":[{"role":"user","content":"hi"}]}`,
		} {
			backend.reset()
			target.reset()
			rec := h.do(t, http.MethodPost, "/v1/messages", body)
			if n := target.total(); n != 0 {
				t.Fatalf("%d: the redirect target got %d request(s), auth %v", status, n, target.auth)
			}
			if n := backend.total(); n != 1 {
				t.Fatalf("%d: backend got %d requests", status, n)
			}
			if rec.Code == http.StatusUnauthorized {
				t.Fatalf("%d: a backend redirect became a 401", status)
			}
		}
	}
}
