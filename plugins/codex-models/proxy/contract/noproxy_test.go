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
	e := newEnv(t, opts{
		noStart: true,
		rawConfig: func(cfg map[string]any) {
			cfg["upstream"] = "http://anthropic.invalid:1"
			cfg["codex"].(map[string]any)["base_url"] = "http://codex.invalid:1/backend-api/codex"
		},
		extraEnv: append(proxyVars(trap.addr),
			"CCMPROXY_CONTRACT_UPSTREAM=http://anthropic.invalid:1",
			"CCMPROXY_CONTRACT_CODEX_BASE_URL=http://codex.invalid:1/backend-api/codex",
			"CCMPROXY_CONTRACT_OAUTH_TOKEN_URL=http://oauth.invalid:1/token",
			"CCMPROXY_CONTRACT_OAUTH_AUTH_URL=http://oauth.invalid:1/authorize",
		),
	})
	past := time.Now().Add(-time.Hour)
	e.writeLogin(login{expires: past, access: accessToken("old", past)})
	e.start()

	check := func(name string, r resp) {
		t.Helper()
		if r.Status != http.StatusBadGateway {
			t.Fatalf("%s: status = %d, want 502: %s", name, r.Status, r.Body)
		}
		if kind, _ := r.errInfo(t); kind != "api_error" {
			t.Fatalf("%s: error type = %q", name, kind)
		}
	}
	check("passthrough", e.post("/v1/messages", claudeReq("claude-sonnet-5", false, nil)))
	check("models without a usable login", e.do(http.MethodGet, "/v1/organizations/o", nil, nil))
	// The expired login needs the token endpoint, which is unreachable too.
	check("codex refresh", e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)))
	// With a still-valid login the upstream failure is hidden behind the added models.
	e.writeLogin(login{})
	time.Sleep(30 * time.Millisecond)
	if r := e.do(http.MethodGet, "/v1/models", nil, nil); r.Status != 200 {
		t.Fatalf("models: status = %d: %s", r.Status, r.Body)
	}
	check("codex backend", e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)))

	time.Sleep(200 * time.Millisecond)
	if n := trap.conns.Load(); n != 0 {
		t.Fatalf("the proxy variables were honoured: %d connections to the trap", n)
	}
}

// The same variables do not disturb requests to reachable fakes.
func TestProxyEnvironmentVariablesDoNotDisturbTheFakes(t *testing.T) {
	trap := newProxyTrap(t)
	e := newEnv(t, opts{noStart: true, extraEnv: proxyVars(trap.addr)})
	past := time.Now().Add(-time.Hour)
	e.writeLogin(login{expires: past, access: accessToken("old", past)})
	e.oauth.set(refreshing(accessToken("new", time.Now().Add(time.Hour)), "refresh-2", false))
	e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(`{}`)) })
	e.start()
	for _, r := range []resp{
		e.post("/v1/messages", claudeReq("claude-sonnet-5", false, nil)),
		e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)),
	} {
		if r.Status != 200 {
			t.Fatalf("status = %d: %s", r.Status, r.Body)
		}
	}
	if e.anth.count() != 1 || e.cdx.count() != 1 || e.oauth.count() != 1 {
		t.Fatalf("fakes saw anthropic=%d codex=%d oauth=%d", e.anth.count(), e.cdx.count(), e.oauth.count())
	}
	if n := trap.conns.Load(); n != 0 {
		t.Fatalf("%d connections to the trap", n)
	}
}
