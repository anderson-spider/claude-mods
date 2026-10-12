//go:build contract

package contract

import (
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestCodexErrorMapping(t *testing.T) {
	e := loggedIn(t, opts{})
	cases := []struct {
		codex      int
		wantStatus int
		wantType   string
	}{
		{400, 400, "invalid_request_error"},
		{422, 422, "invalid_request_error"},
		{403, 403, "permission_error"},
		{404, 404, "not_found_error"},
		{413, 413, "request_too_large"},
		{429, 429, "rate_limit_error"},
		{529, 529, "overloaded_error"},
		{500, 500, "api_error"},
		{502, 502, "api_error"},
		{503, 503, "api_error"},
		{401, 403, "permission_error"}, // never 401 toward Claude Code
	}
	for _, stream := range []bool{true, false} {
		for _, c := range cases {
			name := strings.Join([]string{itoa3(c.codex), map[bool]string{true: "stream", false: "json"}[stream]}, "/")
			t.Run(name, func(t *testing.T) {
				e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(c.codex)
					_, _ = w.Write([]byte(`{"error":{"message":"  the  backend\n\tsaid   no ","type":"some_type","code":"some_code"}}`))
				})
				r := e.post("/v1/messages", claudeReq("gpt-6-astra", stream, nil))
				if r.Status != c.wantStatus {
					t.Fatalf("status = %d, want %d: %s", r.Status, c.wantStatus, r.Body)
				}
				if r.Status == 401 {
					t.Fatal("a 401 reached the client")
				}
				kind, msg := r.errInfo(t)
				if kind != c.wantType {
					t.Fatalf("error type = %q, want %q", kind, c.wantType)
				}
				if c.codex == 401 {
					if !strings.HasPrefix(msg, "the Codex backend refused the ChatGPT login; run `ccmproxy login codex` to sign in again: ") ||
						!strings.HasSuffix(msg, "the backend said no") {
						t.Fatalf("401 message = %q", msg)
					}
				} else if msg != "the backend said no" {
					t.Fatalf("message = %q, want the cleaned upstream text", msg)
				}
			})
		}
	}
}

func itoa3(n int) string {
	return string([]byte{byte('0' + n/100), byte('0' + n/10%10), byte('0' + n%10)})
}

func TestCodexErrorMessageShapes(t *testing.T) {
	e := loggedIn(t, opts{})
	reply := func(status int, body string) resp {
		e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
		})
		return e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
	}

	t.Run("long message is capped at 300 characters", func(t *testing.T) {
		long := strings.Repeat("ab ", 400) + "\x00\x1b[31mred"
		_, msg := reply(400, `{"error":{"message":`+jsonStr(long)+`}}`).errInfo(t)
		if n := utf8.RuneCountInString(msg); n > 301 || !strings.HasSuffix(msg, "…") {
			t.Fatalf("message has %d runes: %q", n, msg)
		}
		if strings.ContainsAny(msg, "\x00\x1b\n\t") || strings.Contains(msg, "  ") {
			t.Fatalf("message keeps control characters or runs of space: %q", msg)
		}
		golden(t, "codex_error_long_message.golden", []byte(msg+"\n"))
	})
	t.Run("detail field", func(t *testing.T) {
		kind, msg := reply(404, `{"detail":"model not on this plan"}`).errInfo(t)
		if kind != "not_found_error" || msg != "model not on this plan" {
			t.Fatalf("got %s %q", kind, msg)
		}
	})
	t.Run("plain text body", func(t *testing.T) {
		kind, msg := reply(500, "upstream\n\nexploded").errInfo(t)
		if kind != "api_error" || msg != "upstream exploded" {
			t.Fatalf("got %s %q", kind, msg)
		}
	})
	t.Run("empty body names the status", func(t *testing.T) {
		kind, msg := reply(429, "").errInfo(t)
		if kind != "rate_limit_error" || msg != "Too Many Requests" {
			t.Fatalf("got %s %q", kind, msg)
		}
	})
	t.Run("a redirect is an error, not followed", func(t *testing.T) {
		e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
			w.Header().Set("Location", "http://127.0.0.1:1/x")
			w.WriteHeader(http.StatusTemporaryRedirect)
		})
		before := e.cdx.count()
		r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
		if r.Status != http.StatusBadGateway {
			t.Fatalf("status = %d", r.Status)
		}
		if kind, _ := r.errInfo(t); kind != "api_error" {
			t.Fatalf("type = %q", kind)
		}
		if e.cdx.count() != before+1 {
			t.Fatal("the redirect was followed")
		}
	})
	t.Run("invalid request body", func(t *testing.T) {
		r := e.post("/v1/messages", []byte(`{"model":"gpt-6-astra","messages":`))
		// The model cannot be read, so it is treated as a Claude model.
		if r.Status == http.StatusOK {
			t.Fatalf("status = %d", r.Status)
		}
	})
}

func TestCodexWithoutALogin(t *testing.T) {
	e := newEnv(t, opts{})
	for _, stream := range []bool{true, false} {
		r := e.post("/v1/messages", claudeReq("gpt-6-astra", stream, nil))
		if r.Status != http.StatusForbidden {
			t.Fatalf("stream=%v: status = %d", stream, r.Status)
		}
		kind, msg := r.errInfo(t)
		if kind != "permission_error" || !strings.Contains(msg, "ccmproxy login codex") {
			t.Fatalf("got %s %q", kind, msg)
		}
	}
	if e.cdx.count() != 0 {
		t.Fatal("Codex was called without a login")
	}
}
