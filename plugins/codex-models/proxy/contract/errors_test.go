//go:build contract

package contract

import (
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestRemoteErrorMapping(t *testing.T) {
	e := withAccount(t, opts{})
	cases := []struct {
		remote     int
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
			name := strings.Join([]string{itoa3(c.remote), map[bool]string{true: "stream", false: "json"}[stream]}, "/")
			t.Run(name, func(t *testing.T) {
				e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(c.remote)
					_, _ = w.Write([]byte(`{"type":"error","error":{"message":"  the  backend\n\tsaid   no ","type":"some_type"}}`))
				})
				r := e.post("/v1/messages", claudeReq("gpt-6-astra", stream, nil))
				if r.Status != c.wantStatus {
					t.Fatalf("status = %d, want %d: %s", r.Status, c.wantStatus, r.Body)
				}
				kind, msg := r.errInfo(t)
				if kind != c.wantType {
					t.Fatalf("error type = %q, want %q", kind, c.wantType)
				}
				if c.remote == 401 {
					if !strings.HasPrefix(msg, "the Codex remote refused the request") || !strings.HasSuffix(msg, "the backend said no") {
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

func TestRemoteErrorMessageShapes(t *testing.T) {
	e := withAccount(t, opts{})
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
	t.Run("an error answered with 200 keeps its type", func(t *testing.T) {
		e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"overloaded_error","message":"busy"}}`))
		})
		r := e.post("/v1/messages", claudeReq("gpt-6-astra", false, nil))
		if kind, _ := r.errInfo(t); r.Status != 529 || kind != "overloaded_error" {
			t.Fatalf("status = %d, type %q: %s", r.Status, kind, r.Body)
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

// Without a remote, or with the remote down, a Codex request fails fast with
// 503 api_error and nothing reaches Anthropic.
func TestRemoteMissingOrDown(t *testing.T) {
	t.Run("no remote configured", func(t *testing.T) {
		e := newEnv(t, opts{noRemote: true})
		for _, stream := range []bool{true, false} {
			r := e.post("/v1/messages", claudeReq("gpt-6-astra", stream, nil))
			if kind, _ := r.errInfo(t); r.Status != http.StatusServiceUnavailable || kind != "api_error" {
				t.Fatalf("stream=%v: %d %s", stream, r.Status, r.Body)
			}
		}
		if e.anth.count() != 0 {
			t.Fatal("a Codex request went to Anthropic")
		}
	})
	t.Run("remote down", func(t *testing.T) {
		e := withAccount(t, opts{})
		e.cdx.Close()
		start := time.Now()
		r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
		if kind, _ := r.errInfo(t); r.Status != http.StatusServiceUnavailable || kind != "api_error" {
			t.Fatalf("%d %s", r.Status, r.Body)
		}
		if d := time.Since(start); d > 5*time.Second {
			t.Fatalf("the failure took %v", d)
		}
		if e.anth.count() != 0 {
			t.Fatal("a Codex request went to Anthropic")
		}
	})
}
