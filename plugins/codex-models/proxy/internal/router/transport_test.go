package router

import (
	"net/http"
	"testing"

	"github.com/jclab-joseph/claude-code-model-proxy/internal/codex"
	"github.com/jclab-joseph/claude-code-model-proxy/internal/config"
	"github.com/jclab-joseph/claude-code-model-proxy/internal/netx"
)

func TestANilTransportIsTheDirectOne(t *testing.T) {
	r, err := New(config.Default(), codex.NewRegistry(nil, "", false), nil, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for name, rt := range map[string]http.RoundTripper{"passthrough": r.proxy.Transport, "client": r.client.Transport} {
		if rt == http.DefaultTransport {
			t.Fatalf("%s uses http.DefaultTransport, which honours HTTPS_PROXY", name)
		}
		tr, ok := rt.(*http.Transport)
		if !ok || tr.Proxy != nil || tr != netx.Shared() {
			t.Fatalf("%s transport = %#v, want netx.Shared()", name, rt)
		}
	}
}
