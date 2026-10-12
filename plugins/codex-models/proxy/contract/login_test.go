//go:build contract

package contract

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const codexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"

// refreshing answers the token endpoint with a fresh token set.
func refreshing(access, refresh string, omitRefresh bool) handlerFunc {
	return func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.Header().Set("Content-Type", "application/json")
		out := map[string]any{
			"access_token": access,
			"id_token":     idToken("id-2"),
			"token_type":   "Bearer",
			"expires_in":   3600,
		}
		if !omitRefresh {
			out["refresh_token"] = refresh
		}
		_ = json.NewEncoder(w).Encode(out)
	}
}

func readLogin(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	must(t, err)
	var m map[string]any
	must(t, json.Unmarshal(data, &m))
	return m
}

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	must(t, err)
	return info.Mode().Perm()
}

func TestExpiredTokenIsRefreshedAndPersisted(t *testing.T) {
	for _, tlsOAuth := range []bool{false, true} {
		name := map[bool]string{false: "http", true: "tls with the contract roots"}[tlsOAuth]
		t.Run(name, func(t *testing.T) {
			e := newEnv(t, opts{tlsOAuth: tlsOAuth, noStart: true})
			past := time.Now().Add(-time.Hour)
			path := e.writeLogin(login{expires: past, access: accessToken("old", past), refresh: "refresh-1", mode: 0o644})
			fresh := accessToken("new", time.Now().Add(time.Hour))
			e.oauth.set(refreshing(fresh, "refresh-2", false))
			e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
			e.start()

			r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
			if r.Status != 200 {
				t.Fatalf("status = %d: %s", r.Status, r.Body)
			}
			if e.oauth.count() != 1 {
				t.Fatalf("token endpoint calls = %d", e.oauth.count())
			}
			tok := e.oauth.last(t)
			if tok.Method != "POST" || tok.Path != "/token" {
				t.Fatalf("token endpoint saw %s %s", tok.Method, tok.Path)
			}
			if ct := tok.Header.Get("Content-Type"); ct != "application/x-www-form-urlencoded" {
				t.Fatalf("Content-Type = %q", ct)
			}
			form, err := url.ParseQuery(string(tok.Body))
			must(t, err)
			for k, v := range map[string]string{
				"grant_type": "refresh_token", "client_id": codexClientID,
				"refresh_token": "refresh-1", "scope": "openid profile email",
			} {
				if form.Get(k) != v {
					t.Fatalf("form %s = %q, want %q", k, form.Get(k), v)
				}
			}
			if got := e.cdx.last(t).Header.Get("Authorization"); got != "Bearer "+fresh {
				t.Fatal("Codex was called with the old access token")
			}

			saved := readLogin(t, path)
			if saved["access_token"] != fresh || saved["refresh_token"] != "refresh-2" {
				t.Fatalf("saved login = %v", saved)
			}
			if saved["account_id"] != "acct-1" || saved["email"] != "user@example.test" || saved["type"] != "codex" {
				t.Fatalf("saved login lost its account fields: %v", saved)
			}
			if m := mode(t, path); m != 0o600 {
				t.Fatalf("login file mode = %o, want 600", m)
			}
			if m := mode(t, e.authDir); m != 0o700 {
				t.Fatalf("auth_dir mode = %o, want 700", m)
			}
			// No second refresh while the new token lives.
			e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
			if e.oauth.count() != 1 {
				t.Fatalf("token endpoint calls = %d after a second request", e.oauth.count())
			}
		})
	}
}

func TestRefreshKeepsTheOldRefreshTokenWhenOmitted(t *testing.T) {
	e := newEnv(t, opts{noStart: true})
	past := time.Now().Add(-time.Minute)
	path := e.writeLogin(login{expires: past, refresh: "refresh-keep"})
	e.oauth.set(refreshing(accessToken("new", time.Now().Add(time.Hour)), "", true))
	e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	e.start()
	if r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)); r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	if got := readLogin(t, path)["refresh_token"]; got != "refresh-keep" {
		t.Fatalf("refresh_token = %v", got)
	}
}

func TestTokenInsideTheRefreshWindowIsRenewedAndOutsideIsNot(t *testing.T) {
	for _, c := range []struct {
		name    string
		expires time.Duration
		calls   int
	}{{"two minutes left", 2 * time.Minute, 1}, {"half an hour left", 30 * time.Minute, 0}} {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t, opts{noStart: true})
			e.writeLogin(login{expires: time.Now().Add(c.expires)})
			e.oauth.set(refreshing(accessToken("new", time.Now().Add(time.Hour)), "refresh-2", false))
			e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
			e.start()
			e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
			if e.oauth.count() != c.calls {
				t.Fatalf("token endpoint calls = %d, want %d", e.oauth.count(), c.calls)
			}
		})
	}
}

// A refusal of the grant answers 403 and is not retried until the file changes.
func TestRejectedRefreshIsNotRetriedUntilTheFileChanges(t *testing.T) {
	e := newEnv(t, opts{noStart: true})
	past := time.Now().Add(-time.Hour)
	path := e.writeLogin(login{expires: past, access: accessToken("old", past), refresh: "refresh-1"})
	e.oauth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"refresh token already used"}`))
	})
	e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	e.start()

	for i := 0; i < 3; i++ {
		r := e.post("/v1/messages", claudeReq("gpt-6-astra", i%2 == 0, nil))
		if r.Status != http.StatusForbidden {
			t.Fatalf("request %d: status = %d, want 403: %s", i, r.Status, r.Body)
		}
		kind, msg := r.errInfo(t)
		if kind != "permission_error" || !strings.Contains(msg, "ccmproxy login codex") {
			t.Fatalf("request %d: %s %q", i, kind, msg)
		}
		if strings.Contains(msg, "already used") {
			t.Fatalf("the token endpoint's text reached the client: %q", msg)
		}
	}
	if e.oauth.count() != 1 {
		t.Fatalf("token endpoint calls = %d, want 1 (no retry)", e.oauth.count())
	}
	if e.cdx.count() != 0 {
		t.Fatal("Codex was called with an expired token")
	}

	// A new login in the file clears the refusal.
	time.Sleep(30 * time.Millisecond)
	e.writeLogin(login{expires: past, access: accessToken("old2", past), refresh: "refresh-3"})
	fresh := accessToken("new", time.Now().Add(time.Hour))
	e.oauth.set(refreshing(fresh, "refresh-4", false))
	r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
	if r.Status != 200 {
		t.Fatalf("after the file changed: status = %d: %s", r.Status, r.Body)
	}
	if e.oauth.count() != 2 {
		t.Fatalf("token endpoint calls = %d, want 2", e.oauth.count())
	}
	if readLogin(t, path)["refresh_token"] != "refresh-4" {
		t.Fatal("the refreshed login was not saved")
	}
}

// A failure that may pass (5xx) is not remembered, and an expired token then
// answers an error that is not a 403 about signing in again.
func TestTransientRefreshFailureIsRetried(t *testing.T) {
	e := newEnv(t, opts{noStart: true})
	e.writeLogin(login{expires: time.Now().Add(-time.Hour)})
	e.oauth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { w.WriteHeader(http.StatusServiceUnavailable) })
	e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	e.start()
	for i := 0; i < 2; i++ {
		r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
		if r.Status != http.StatusBadGateway {
			t.Fatalf("status = %d: %s", r.Status, r.Body)
		}
	}
	if e.oauth.count() != 2 {
		t.Fatalf("token endpoint calls = %d, want 2", e.oauth.count())
	}
}

func TestTokenEndpointRedirectIsNotFollowed(t *testing.T) {
	e := newEnv(t, opts{noStart: true})
	e.writeLogin(login{expires: time.Now().Add(-time.Hour)})
	target := newFake(t, false)
	e.oauth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.Header().Set("Location", target.URL+"/steal")
		w.WriteHeader(http.StatusTemporaryRedirect)
	})
	e.start()
	r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
	if r.Status == 200 {
		t.Fatalf("status = %d", r.Status)
	}
	if target.count() != 0 {
		t.Fatalf("the refresh token was replayed to the redirect target: %s", target.last(t).Body)
	}
}

func cliAuthJSON(access, refresh string) map[string]any {
	return map[string]any{
		"auth_mode":      "chatgpt",
		"OPENAI_API_KEY": nil,
		"tokens": map[string]any{
			"id_token":      idToken("cli"),
			"access_token":  access,
			"refresh_token": refresh,
			"account_id":    "acct-cli",
		},
		"last_refresh": "2026-10-01T10:00:00.000000Z",
	}
}

func writeCLILogin(t *testing.T, e *env, access string) (string, []byte, time.Time) {
	t.Helper()
	must(t, os.MkdirAll(e.codexHome, 0o700))
	path := filepath.Join(e.codexHome, "auth.json")
	writeJSON(t, path, cliAuthJSON(access, "cli-refresh"), 0o600)
	data, err := os.ReadFile(path)
	must(t, err)
	info, err := os.Stat(path)
	must(t, err)
	return path, data, info.ModTime()
}

func unchanged(t *testing.T, path string, data []byte, mtime time.Time) {
	t.Helper()
	now, err := os.ReadFile(path)
	must(t, err)
	info, err := os.Stat(path)
	must(t, err)
	if string(now) != string(data) || !info.ModTime().Equal(mtime) {
		t.Fatalf("%s was modified", path)
	}
}

func TestCodexCLILoginIsBorrowedReadOnly(t *testing.T) {
	t.Run("valid token is used as it is", func(t *testing.T) {
		e := newEnv(t, opts{noStart: true, codexCfg: map[string]any{"use_codex_cli_auth": true}})
		access := accessToken("cli-access", time.Now().Add(time.Hour))
		path, data, mtime := writeCLILogin(t, e, access)
		e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
		e.start()

		for i := 0; i < 2; i++ {
			if r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)); r.Status != 200 {
				t.Fatalf("status = %d: %s", r.Status, r.Body)
			}
		}
		got := e.cdx.last(t)
		if got.Header.Get("Authorization") != "Bearer "+access || got.Header.Get("Chatgpt-Account-Id") != "acct-cli" {
			t.Fatalf("Codex saw %q / %q", got.Header.Get("Authorization"), got.Header.Get("Chatgpt-Account-Id"))
		}
		if e.oauth.count() != 0 {
			t.Fatal("the borrowed login was refreshed")
		}
		unchanged(t, path, data, mtime)
		if _, err := os.Stat(filepath.Join(e.authDir, "codex.json")); err == nil {
			t.Fatal("the proxy wrote its own login file from the borrowed one")
		}
		status := e.do(http.MethodGet, "/__ccmproxy/status", nil, nil).json(t)
		if status["codexLogin"] != true {
			t.Fatalf("status = %v", status)
		}
	})

	t.Run("expired token is never refreshed", func(t *testing.T) {
		e := newEnv(t, opts{noStart: true, codexCfg: map[string]any{"use_codex_cli_auth": true}})
		path, data, mtime := writeCLILogin(t, e, accessToken("cli-access", time.Now().Add(-time.Hour)))
		e.oauth.set(refreshing(accessToken("x", time.Now().Add(time.Hour)), "r", false))
		e.start()
		for i := 0; i < 2; i++ {
			r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
			if r.Status != http.StatusForbidden {
				t.Fatalf("status = %d: %s", r.Status, r.Body)
			}
			kind, msg := r.errInfo(t)
			if kind != "permission_error" || !strings.Contains(msg, "Codex CLI login has expired") || !strings.Contains(msg, "codex login") {
				t.Fatalf("%s %q", kind, msg)
			}
		}
		if e.oauth.count() != 0 || e.cdx.count() != 0 {
			t.Fatalf("oauth=%d codex=%d calls", e.oauth.count(), e.cdx.count())
		}
		unchanged(t, path, data, mtime)
	})

	t.Run("not read unless enabled", func(t *testing.T) {
		e := newEnv(t, opts{noStart: true})
		writeCLILogin(t, e, accessToken("cli-access", time.Now().Add(time.Hour)))
		e.start()
		r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
		if r.Status != http.StatusForbidden || e.cdx.count() != 0 {
			t.Fatalf("status = %d, codex calls = %d", r.Status, e.cdx.count())
		}
	})

	t.Run("the proxy's own login wins", func(t *testing.T) {
		e := newEnv(t, opts{noStart: true, codexCfg: map[string]any{"use_codex_cli_auth": true}})
		own := accessToken("own", time.Now().Add(time.Hour))
		e.writeLogin(login{access: own})
		writeCLILogin(t, e, accessToken("cli-access", time.Now().Add(time.Hour)))
		e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
		e.start()
		e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
		if got := e.cdx.last(t).Header.Get("Authorization"); got != "Bearer "+own {
			t.Fatal("the CLI login was preferred to the proxy's own")
		}
	})

	t.Run("auth_file in the CLI layout is read in place", func(t *testing.T) {
		e := newEnv(t, opts{noStart: true})
		access := accessToken("explicit", time.Now().Add(time.Hour))
		path := filepath.Join(e.home, "explicit-auth.json")
		writeJSON(t, path, cliAuthJSON(access, "r"), 0o600)
		cfg := readLogin(t, e.cfgPath)
		cfg["codex"].(map[string]any)["auth_file"] = path
		writeJSON(t, e.cfgPath, cfg, 0o600)
		e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
		e.start()
		if r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)); r.Status != 200 {
			t.Fatalf("status = %d: %s", r.Status, r.Body)
		}
		if got := e.cdx.last(t).Header.Get("Authorization"); got != "Bearer "+access {
			t.Fatalf("Authorization = %q", got)
		}
	})
}

// auth_file naming the Codex CLI's own file is refused at start.
func TestAuthFileCannotBeTheCodexCLIFile(t *testing.T) {
	e := newEnv(t, opts{noStart: true})
	must(t, os.MkdirAll(e.codexHome, 0o700))
	cli := filepath.Join(e.codexHome, "auth.json")
	writeJSON(t, cli, cliAuthJSON(accessToken("x", time.Now().Add(time.Hour)), "r"), 0o600)
	cfg := readLogin(t, e.cfgPath)
	cfg["codex"].(map[string]any)["auth_file"] = cli
	writeJSON(t, e.cfgPath, cfg, 0o600)
	out, code := runCLI(t, e.home, e.environ(), "serve")
	if code == 0 || !strings.Contains(out.stderr, "never writes") {
		t.Fatalf("exit %d, stderr: %s", code, out.stderr)
	}
}
