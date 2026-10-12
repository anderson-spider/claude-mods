//go:build contract

package contract

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type loginRun struct {
	cmd    *exec.Cmd
	stdout *syncBuf
	stderr *syncBuf
	done   chan struct{}
	err    error
	url    *url.URL
}

func startLogin(t *testing.T, e *env) *loginRun {
	t.Helper()
	l := &loginRun{stdout: &syncBuf{}, stderr: &syncBuf{}, done: make(chan struct{})}
	l.cmd = exec.Command(binPath, "login", "codex", "--no-browser")
	l.cmd.Env = e.environ()
	l.cmd.Stdout, l.cmd.Stderr = l.stdout, l.stderr
	must(t, l.cmd.Start())
	go func() { l.err = l.cmd.Wait(); close(l.done) }()
	t.Cleanup(func() {
		select {
		case <-l.done:
		default:
			_ = l.cmd.Process.Kill()
			<-l.done
		}
	})
	waitUntil(t, "the authorize URL", 10*time.Second, func() bool {
		sc := bufio.NewScanner(strings.NewReader(l.stdout.String()))
		for sc.Scan() {
			if line := strings.TrimSpace(sc.Text()); strings.HasPrefix(line, "http") {
				u, err := url.Parse(line)
				if err == nil {
					l.url = u
					return true
				}
			}
		}
		return false
	})
	return l
}

func (l *loginRun) running() bool {
	select {
	case <-l.done:
		return false
	default:
		return true
	}
}

func (l *loginRun) wait(t *testing.T) error {
	t.Helper()
	select {
	case <-l.done:
		return l.err
	case <-time.After(15 * time.Second):
		t.Fatal("login did not finish")
		return nil
	}
}

func callbackGet(t *testing.T, port, method, query string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, "http://127.0.0.1:"+port+"/auth/callback"+query, nil)
	must(t, err)
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	must(t, err)
	_ = res.Body.Close()
	return res
}

func loginEnv(t *testing.T, extra map[string]any) (*env, string) {
	t.Helper()
	port := freeAddr(t)
	port = port[strings.LastIndex(port, ":")+1:]
	e := newEnv(t, opts{noStart: true, codexCfg: mergeMaps(map[string]any{"callback_port": mustAtoi(t, port)}, extra)})
	return e, port
}

func mergeMaps(a, b map[string]any) map[string]any {
	for k, v := range b {
		a[k] = v
	}
	return a
}

func mustAtoi(t *testing.T, s string) int {
	t.Helper()
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

func TestLoginNoBrowser(t *testing.T) {
	e, port := loginEnv(t, nil)
	access := accessToken("login-access", time.Now().Add(time.Hour))
	e.oauth.set(refreshing(access, "login-refresh", false))
	l := startLogin(t, e)

	q := l.url.Query()
	if got := l.url.Scheme + "://" + l.url.Host + l.url.Path; got != e.oauth.URL+"/authorize" {
		t.Fatalf("authorize endpoint = %q", got)
	}
	for k, v := range map[string]string{
		"client_id": codexClientID, "response_type": "code", "redirect_uri": "http://localhost:" + port + "/auth/callback",
		"scope": "openid email profile offline_access", "code_challenge_method": "S256", "prompt": "login",
		"id_token_add_organizations": "true", "codex_cli_simplified_flow": "true",
	} {
		if q.Get(k) != v {
			t.Fatalf("authorize %s = %q, want %q", k, q.Get(k), v)
		}
	}
	state, challenge := q.Get("state"), q.Get("code_challenge")
	if len(state) < 16 || challenge == "" {
		t.Fatalf("state %q challenge %q", state, challenge)
	}

	// Anything but the provider's redirect with this login's state is answered and ignored.
	if res := callbackGet(t, port, http.MethodPost, "?state="+state+"&code=abc"); res.StatusCode != http.StatusMethodNotAllowed || res.Header.Get("Allow") != "GET" {
		t.Fatalf("POST: %d allow=%q", res.StatusCode, res.Header.Get("Allow"))
	}
	for _, query := range []string{"", "?code=abc", "?state=wrong&code=abc", "?state=" + state[:len(state)-1] + "&code=abc"} {
		if res := callbackGet(t, port, http.MethodGet, query); res.StatusCode != http.StatusBadRequest {
			t.Fatalf("GET %q: %d", query, res.StatusCode)
		}
	}
	if !l.running() || e.oauth.count() != 0 {
		t.Fatalf("login ended or exchanged a code on a bad callback (oauth calls %d)", e.oauth.count())
	}

	if res := callbackGet(t, port, http.MethodGet, "?state="+state+"&code=abc"); res.StatusCode != http.StatusOK {
		t.Fatalf("good callback: %d", res.StatusCode)
	}
	if err := l.wait(t); err != nil {
		t.Fatalf("login failed: %v\n%s", err, l.stderr.String())
	}
	if !strings.Contains(l.stdout.String(), "Signed in as user@example.test (plus plan).") ||
		!strings.Contains(l.stdout.String(), "codex.json") {
		t.Fatalf("stdout = %s", l.stdout.String())
	}

	if e.oauth.count() != 1 {
		t.Fatalf("token endpoint calls = %d", e.oauth.count())
	}
	form, err := url.ParseQuery(string(e.oauth.last(t).Body))
	must(t, err)
	sum := sha256.Sum256([]byte(form.Get("code_verifier")))
	for k, v := range map[string]string{
		"grant_type": "authorization_code", "client_id": codexClientID, "code": "abc",
		"redirect_uri": "http://localhost:" + port + "/auth/callback",
	} {
		if form.Get(k) != v {
			t.Fatalf("exchange %s = %q, want %q", k, form.Get(k), v)
		}
	}
	if form.Get("code_verifier") == "" || base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
		t.Fatal("code_verifier does not match the S256 challenge")
	}

	path := filepath.Join(e.authDir, "codex.json")
	if m := mode(t, path); m != 0o600 {
		t.Fatalf("login file mode = %o", m)
	}
	if m := mode(t, e.authDir); m != 0o700 {
		t.Fatalf("auth_dir mode = %o", m)
	}
	saved := readLogin(t, path)
	if saved["access_token"] != access || saved["refresh_token"] != "login-refresh" || saved["account_id"] != "acct-1" {
		t.Fatalf("saved login = %v", saved)
	}

	// A serve started afterwards uses it.
	e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	e.start()
	if r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)); r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	if got := e.cdx.last(t).Header.Get("Authorization"); got != "Bearer "+access {
		t.Fatal("serve did not use the login")
	}
}

func TestLoginRefusedByTheProvider(t *testing.T) {
	e, port := loginEnv(t, nil)
	l := startLogin(t, e)
	state := l.url.Query().Get("state")
	res := callbackGet(t, port, http.MethodGet, "?state="+state+"&error=access_denied&error_description=nope")
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if err := l.wait(t); err == nil || !strings.Contains(l.stderr.String(), "authorization failed: access_denied: nope") {
		t.Fatalf("err = %v, stderr = %s", err, l.stderr.String())
	}
	if e.oauth.count() != 0 {
		t.Fatal("a code was exchanged")
	}
	if _, err := os.Stat(filepath.Join(e.authDir, "codex.json")); err == nil {
		t.Fatal("a login file was written")
	}
}

func TestLoginRejectedExchangeWritesNothing(t *testing.T) {
	e, port := loginEnv(t, nil)
	e.oauth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
	})
	l := startLogin(t, e)
	callbackGet(t, port, http.MethodGet, "?state="+l.url.Query().Get("state")+"&code=abc")
	if err := l.wait(t); err == nil || !strings.Contains(l.stderr.String(), "token endpoint returned 400") {
		t.Fatalf("err = %v, stderr = %s", err, l.stderr.String())
	}
	if _, err := os.Stat(filepath.Join(e.authDir, "codex.json")); err == nil {
		t.Fatal("a login file was written")
	}
}

func TestLogoutRemovesOnlyTheProxysOwnLogin(t *testing.T) {
	e := newEnv(t, opts{noStart: true, codexCfg: map[string]any{"use_codex_cli_auth": true}})
	own := e.writeLogin(login{})
	cli, data, mtime := writeCLILogin(t, e, accessToken("cli", time.Now().Add(time.Hour)))

	out, code := runCLI(t, e.home, e.environ(), "logout")
	if code != 0 || !strings.Contains(out.stdout, "Removed ") || !strings.Contains(out.stdout, "codex.json") ||
		!strings.Contains(out.stdout, "is untouched and will still be used.") {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, out.stdout, out.stderr)
	}
	if _, err := os.Stat(own); err == nil {
		t.Fatal("the proxy's login file is still there")
	}
	unchanged(t, cli, data, mtime)

	out, code = runCLI(t, e.home, e.environ(), "logout", "codex")
	if code != 0 || out.stdout != "No Codex credentials were stored.\n" {
		t.Fatalf("second logout: exit %d %q", code, out.stdout)
	}
	unchanged(t, cli, data, mtime)

	if out, code := runCLI(t, e.home, e.environ(), "logout", "other"); code != 1 || !strings.Contains(out.stderr, "only `codex` is supported") {
		t.Fatalf("other provider: exit %d %q", code, out.stderr)
	}
}
