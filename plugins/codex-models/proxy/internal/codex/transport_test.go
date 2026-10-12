package codex

import (
	"net/http"
	"testing"

	"github.com/jclab-joseph/claude-code-model-proxy/internal/netx"
)

func TestNilTransportsAreTheDirectOne(t *testing.T) {
	backend := NewBackend("https://chatgpt.com/backend-api/codex", "ua", "codex-tui", nil, nil)
	client := NewClient(nil)
	for name, rt := range map[string]http.RoundTripper{"backend": backend.HTTP.Transport, "oauth": client.HTTP.Transport} {
		if rt == nil || rt == http.DefaultTransport {
			t.Fatalf("%s falls back to http.DefaultTransport, which honours HTTPS_PROXY", name)
		}
		if tr, ok := rt.(*http.Transport); !ok || tr.Proxy != nil || tr != netx.Shared() {
			t.Fatalf("%s transport = %#v, want netx.Shared()", name, rt)
		}
	}
	if client.HTTP.Timeout <= 0 {
		t.Fatal("the OAuth client lost its timeout")
	}
}
