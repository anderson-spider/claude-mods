package router

import (
	"net/http"
	"sync"
	"testing"
)

func TestUpstreamRedirectsAreNeverFollowed(t *testing.T) {
	var mu sync.Mutex
	hits := map[string]int{}
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits[r.URL.Path]++
		mu.Unlock()
		if r.URL.Path == "/elsewhere" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.Header().Set("Location", "/elsewhere")
		w.WriteHeader(http.StatusFound)
	}, nil, false)

	for _, tc := range []struct{ method, target, body, path string }{
		{http.MethodGet, "/v1/models", "", "/v1/models"},
		{http.MethodGet, "/v1/models?after_id=x", "", "/v1/models"},
		{http.MethodPost, "/v1/messages", `{"model":"claude-opus-5","messages":[]}`, "/v1/messages"},
		{http.MethodPost, "/v1/complete", `{}`, "/v1/complete"},
		{http.MethodGet, "/api/claude_cli/bootstrap", "", "/api/claude_cli/bootstrap"},
	} {
		mu.Lock()
		hits = map[string]int{}
		mu.Unlock()
		rec := h.do(t, tc.method, tc.target, tc.body)
		mu.Lock()
		got := hits
		mu.Unlock()
		if got["/elsewhere"] != 0 {
			t.Fatalf("%s %s: the redirect was followed (%v)", tc.method, tc.target, got)
		}
		if got[tc.path] != 1 {
			t.Fatalf("%s %s: upstream hits = %v, want one", tc.method, tc.target, got)
		}
		if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/elsewhere" {
			t.Fatalf("%s %s: got %d Location %q, want the 302 passed back", tc.method, tc.target, rec.Code, rec.Header().Get("Location"))
		}
	}
}
