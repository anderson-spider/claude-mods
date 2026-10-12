package netx

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

// AssertDirect fails unless transport would dial the request's own host with
// the proxy environment variables pointing elsewhere. Go never proxies a
// loopback host, so the request names a non-loopback host and the dialer
// records what it was asked to reach.
func assertDirect(t *testing.T, name string, transport *http.Transport) {
	t.Helper()
	if transport.Proxy != nil {
		t.Fatalf("%s: Proxy is set", name)
	}
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer origin.Close()

	probe := transport.Clone()
	var dialed string
	probe.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialed = addr
		return (&net.Dialer{}).DialContext(ctx, network, origin.Listener.Addr().String())
	}
	resp, err := (&http.Client{Transport: probe}).Get("http://origin.example:80/")
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	_ = resp.Body.Close()
	if dialed != "origin.example:80" {
		t.Fatalf("%s dialed %q, want the origin itself", name, dialed)
	}
}

func TestDirectTransportIgnoresTheProxyEnvironment(t *testing.T) {
	for _, name := range []string{"HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"} {
		t.Setenv(name, "http://proxy.example:3128")
	}
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")

	assertDirect(t, "DirectTransport", DirectTransport())
	assertDirect(t, "Shared", Shared())
	if Shared() != Shared() {
		t.Fatal("Shared must return one transport")
	}
}
