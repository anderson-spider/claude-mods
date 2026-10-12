//go:build contract

package contract

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

func TestStatus(t *testing.T) {
	check := func(t *testing.T, e *env, wantLogin bool) {
		r := e.do(http.MethodGet, "/__ccmproxy/status", nil, nil)
		if r.Status != 200 {
			t.Fatalf("status = %d: %s", r.Status, r.Body)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Fatalf("content-type = %q", ct)
		}
		var got struct {
			Service    string   `json:"service"`
			Version    string   `json:"version"`
			CodexLogin bool     `json:"codexLogin"`
			Models     []string `json:"models"`
		}
		must(t, json.Unmarshal(r.Body, &got))
		if got.Service != "ccmproxy" || got.Version != "contract" || got.CodexLogin != wantLogin {
			t.Fatalf("status = %+v", got)
		}
		if got.Models == nil || len(got.Models) == 0 {
			t.Fatal("no models")
		}
		// Exactly these five keys, and nothing about paths or accounts.
		// Contract change (J1, audited): codexLimits joined the original
		// four. It is always there, [] when nothing has been read; the other
		// four keep their names, types and order.
		var keys map[string]json.RawMessage
		must(t, json.Unmarshal(r.Body, &keys))
		if len(keys) != 5 {
			t.Fatalf("status keys = %v", keys)
		}
		if string(keys["codexLimits"]) != "[]" {
			t.Fatalf("codexLimits = %s, want [] before any reading", keys["codexLimits"])
		}
		if !bytes.HasPrefix(r.Body, []byte(`{"service":"ccmproxy","version":"contract","codexLogin":`)) {
			t.Fatalf("status body starts %.80s", r.Body)
		}
		golden(t, "status_models.golden.json", canonical(t, []byte(mustMarshal(t, got.Models))))
	}
	t.Run("without a remote account", func(t *testing.T) { check(t, newEnv(t, opts{noAccount: true}), false) })
	t.Run("with a remote account", func(t *testing.T) { check(t, withAccount(t, opts{}), true) })

	t.Run("other methods and paths", func(t *testing.T) {
		e := newEnv(t, opts{})
		r := e.do(http.MethodPost, "/__ccmproxy/status", nil, nil)
		if r.Status != http.StatusMethodNotAllowed || r.Header.Get("Allow") != "GET" {
			t.Fatalf("POST status: %d allow=%q", r.Status, r.Header.Get("Allow"))
		}
		if r := e.do(http.MethodGet, "/__ccmproxy/other", nil, nil); r.Status != http.StatusNotFound {
			t.Fatalf("unknown admin path: %d", r.Status)
		}
		if e.anth.count() != 0 {
			t.Fatal("an admin request reached the upstream")
		}
	})
}

func mustMarshal(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	must(t, err)
	return string(b)
}
