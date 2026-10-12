//go:build contract

package contract

import (
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// proxyTrap counts the connections made to it.
type proxyTrap struct {
	addr  string
	conns atomic.Int32
}

func newProxyTrap(t *testing.T) *proxyTrap {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	trap := &proxyTrap{addr: l.Addr().String()}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			trap.conns.Add(1)
			_ = c.Close()
		}
	}()
	t.Cleanup(func() { _ = l.Close() })
	return trap
}

func proxyVars(addr string) []string {
	u := "http://" + addr
	return []string{"HTTP_PROXY=" + u, "HTTPS_PROXY=" + u, "http_proxy=" + u, "https_proxy=" + u, "ALL_PROXY=" + u, "NO_PROXY="}
}

// Environment proxy variables are never used. Go's own proxy selection skips
// loopback hosts, so the fakes cannot show it: the destinations are names
// that cannot resolve, which a proxy-honouring client would hand to the trap.
func TestProxyEnvironmentVariablesAreIgnored(t *testing.T) {
	trap := newProxyTrap(t)
	const remote = "https://codex.invalid:1"
	e := newEnv(t, opts{
		noStart: true,
		rawConfig: func(cfg map[string]any) {
			cfg["upstream"] = "http://anthropic.invalid:1"
			cfg["codex"].(map[string]any)["remote"] = remote
		},
	})
	e.opts.extraEnv = append(proxyVars(trap.addr),
		"CCMPROXY_CONTRACT_UPSTREAM=http://anthropic.invalid:1",
		"CCMPROXY_CONTRACT_REMOTE="+remote,
	)
	e.start()

	check := func(name string, r resp, status int) {
		t.Helper()
		if r.Status != status {
			t.Fatalf("%s: status = %d, want %d: %s", name, r.Status, status, r.Body)
		}
		if kind, _ := r.errInfo(t); kind != "api_error" {
			t.Fatalf("%s: error type = %q", name, kind)
		}
	}
	check("passthrough", e.post("/v1/messages", claudeReq("claude-sonnet-5", false, nil)), http.StatusBadGateway)
	check("other path", e.do(http.MethodGet, "/v1/organizations/o", nil, nil), http.StatusBadGateway)
	check("codex relay", e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)), http.StatusServiceUnavailable)
	e.do(http.MethodGet, "/__ccmproxy/status?refresh=limits", nil, nil)

	time.Sleep(200 * time.Millisecond)
	if n := trap.conns.Load(); n != 0 {
		t.Fatalf("the proxy variables were honoured: %d connections to the trap", n)
	}
}

// The same variables do not disturb requests to reachable fakes.
func TestProxyEnvironmentVariablesDoNotDisturbTheFakes(t *testing.T) {
	trap := newProxyTrap(t)
	e := newEnv(t, opts{noStart: true, extraEnv: proxyVars(trap.addr)})
	e.cdx.set(answerWith(textAnswer("a")...))
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(`{}`)) })
	e.start()
	e.waitLoggedIn()
	for _, r := range []resp{
		e.post("/v1/messages", claudeReq("claude-sonnet-5", false, nil)),
		e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)),
	} {
		if r.Status != 200 {
			t.Fatalf("status = %d: %s", r.Status, r.Body)
		}
	}
	if e.anth.count() != 1 || e.cdx.count() != 1 {
		t.Fatalf("fakes saw anthropic=%d remote=%d", e.anth.count(), e.cdx.count())
	}
	if n := trap.conns.Load(); n != 0 {
		t.Fatalf("%d connections to the trap", n)
	}
}
