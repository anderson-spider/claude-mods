//go:build contract

package contract

import (
	"net/http"
	"strings"
	"testing"
)

func TestGuard(t *testing.T) {
	e := loggedIn(t, opts{})

	refused := func(t *testing.T, r resp, message string) {
		t.Helper()
		if r.Status != http.StatusForbidden {
			t.Fatalf("status = %d, want 403: %s", r.Status, r.Body)
		}
		kind, msg := r.errInfo(t)
		if kind != "permission_error" {
			t.Fatalf("error type = %q", kind)
		}
		if !strings.HasPrefix(msg, "ccmproxy:") {
			t.Fatalf("message %q lacks the ccmproxy: prefix", msg)
		}
		if message != "" && msg != message {
			t.Fatalf("message = %q, want %q", msg, message)
		}
		noCORS(t, r)
	}

	t.Run("no secret", func(t *testing.T) {
		refused(t, e.do(http.MethodGet, "/v1/models", nil, map[string]string{"X-Ccmproxy-Token": "-"}),
			"ccmproxy: missing or wrong X-Ccmproxy-Token")
	})
	t.Run("wrong secret", func(t *testing.T) {
		refused(t, e.do(http.MethodGet, "/v1/models", nil, map[string]string{"X-Ccmproxy-Token": "nope"}),
			"ccmproxy: missing or wrong X-Ccmproxy-Token")
	})
	t.Run("secret twice", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodGet, e.url("/v1/models"), nil)
		req.Header.Add("X-Ccmproxy-Token", e.token)
		req.Header.Add("X-Ccmproxy-Token", e.token)
		res, err := e.client.Do(req)
		must(t, err)
		defer res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", res.StatusCode)
		}
	})
	t.Run("wrong host", func(t *testing.T) {
		refused(t, e.do(http.MethodGet, "/v1/models", nil, map[string]string{"Host": "evil.example"}),
			"ccmproxy: unexpected Host header")
	})
	t.Run("wrong host with hello", func(t *testing.T) {
		r := e.do(http.MethodHead, "/api/hello", nil, map[string]string{"Host": "evil.example", "X-Ccmproxy-Token": "-"})
		if r.Status != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", r.Status)
		}
		noCORS(t, r)
	})
	t.Run("localhost host is accepted", func(t *testing.T) {
		port := e.addr[strings.LastIndex(e.addr, ":")+1:]
		r := e.do(http.MethodGet, "/__ccmproxy/status", nil, map[string]string{"Host": "localhost:" + port})
		if r.Status != http.StatusOK {
			t.Fatalf("status = %d", r.Status)
		}
	})

	for _, method := range []string{"OPTIONS", "TRACE", "PUT", "DELETE", "PATCH", "trace"} {
		for _, withSecret := range []bool{false, true} {
			name := method + " without secret"
			if withSecret {
				name = method + " with secret"
			}
			t.Run(name, func(t *testing.T) {
				h := map[string]string{}
				if !withSecret {
					h["X-Ccmproxy-Token"] = "-"
				}
				r := e.do(method, "/v1/messages", nil, h)
				refused(t, r, "ccmproxy: this method is not served")
			})
		}
	}
	for _, withSecret := range []bool{false, true} {
		name := "CONNECT without secret"
		if withSecret {
			name = "CONNECT with secret"
		}
		t.Run(name, func(t *testing.T) {
			refused(t, e.rawRequest("CONNECT", e.addr, withSecret), "ccmproxy: this method is not served")
			// A tunnel to another host is refused too (by its Host).
			refused(t, e.rawRequest("CONNECT", "example.com:443", withSecret), "")
		})
	}

	t.Run("HEAD /api/hello needs no secret", func(t *testing.T) {
		r := e.do(http.MethodHead, "/api/hello", nil, map[string]string{"X-Ccmproxy-Token": "-"})
		if r.Status != http.StatusOK || len(r.Body) != 0 {
			t.Fatalf("status = %d, body = %q", r.Status, r.Body)
		}
		noCORS(t, r)
	})
	t.Run("GET /api/hello is not the probe", func(t *testing.T) {
		refused(t, e.do(http.MethodGet, "/api/hello", nil, map[string]string{"X-Ccmproxy-Token": "-"}), "")
	})
	t.Run("HEAD elsewhere needs the secret", func(t *testing.T) {
		r := e.do(http.MethodHead, "/v1/models", nil, map[string]string{"X-Ccmproxy-Token": "-"})
		if r.Status != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", r.Status)
		}
		noCORS(t, r)
	})

	if n := e.anth.count() + e.cdx.count() + e.oauth.count(); n != 0 {
		t.Fatalf("a refused request reached a fake (%d requests)", n)
	}
}

// noCORS fails on any Access-Control-* response header.
func noCORS(t *testing.T, r resp) {
	t.Helper()
	for name := range r.Header {
		if strings.HasPrefix(strings.ToLower(name), "access-control-") {
			t.Fatalf("response carries %s", name)
		}
	}
}

// The secret is removed before any outbound call: no fake sees the header, or
// the secret anywhere else in a request.
func TestTokenHeaderNeverReachesAFake(t *testing.T) {
	e := loggedIn(t, opts{})
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[],"has_more":false,"first_id":null,"last_id":null}`))
	})
	e.cdx.set(answerWith(evCreated, evText("ok"), evCompleted))

	e.do(http.MethodGet, "/v1/models", nil, nil)
	e.do(http.MethodGet, "/v1/organizations/x", nil, nil)
	e.post("/v1/messages", claudeReq("claude-sonnet-5", false, nil))
	e.post("/v1/messages/count_tokens", claudeReq("claude-sonnet-5", false, nil))
	e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
	if e.anth.count() != 4 || e.cdx.count() != 1 {
		t.Fatalf("fakes received anthropic=%d codex=%d requests, want 4 and 1", e.anth.count(), e.cdx.count())
	}
	if log := e.stderr.String(); strings.Contains(log, e.token) || strings.Contains(log, e.salt) {
		t.Fatalf("the proxy's log carries a secret:\n%s", log)
	}
	for _, f := range []*fake{e.anth, e.cdx, e.oauth} {
		for _, r := range f.all() {
			if _, ok := r.Header["X-Ccmproxy-Token"]; ok {
				t.Fatalf("%s %s carried X-Ccmproxy-Token", r.Method, r.Path)
			}
			for name, values := range r.Header {
				for _, v := range values {
					if strings.Contains(v, e.token) {
						t.Fatalf("%s %s: header %s carries the secret", r.Method, r.Path, name)
					}
				}
			}
			if strings.Contains(string(r.Body), e.token) {
				t.Fatalf("%s %s: the body carries the secret", r.Method, r.Path)
			}
		}
	}
}
