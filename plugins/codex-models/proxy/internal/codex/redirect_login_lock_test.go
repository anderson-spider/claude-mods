package codex

// Redirects refused for every 3xx and both clients, the login callback's
// method and state checks, and the lock beside the effective credential file.
// Everything runs on temp dirs and local httptest servers.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	redirectBodySentinel     = "BODY-SENTINEL"
	redirectLocationSentinel = "LOCATION-SENTINEL"
)

// redirectPairWithBody starts an https origin that answers status with a
// Location on a plain-http target (host locationHost) and a body sentinel;
// the target counts every request it gets.
func redirectPairWithBody(t *testing.T, status int, locationHost string) (origin *httptest.Server, location string, hits *atomic.Int32) {
	t.Helper()
	hits = &atomic.Int32{}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"stolen","refresh_token":"stolen","expires_in":3600}`))
	}))
	t.Cleanup(target.Close)
	parsed, _ := url.Parse(target.URL)
	location = "http://" + locationHost + ":" + parsed.Port() + "/" + redirectLocationSentinel + "?x=" + redirectLocationSentinel
	origin = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", location)
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(redirectBodySentinel))
	}))
	t.Cleanup(origin.Close)
	return origin, location, hits
}

var everyRedirectStatus = []int{
	http.StatusMovedPermanently,  // 301
	http.StatusFound,             // 302
	http.StatusSeeOther,          // 303
	http.StatusTemporaryRedirect, // 307
	http.StatusPermanentRedirect, // 308
}

// "localhost" is another origin (other host, http); "127.0.0.1" is the same
// host as the https origin, downgraded to http.
var redirectHosts = []string{"localhost", "127.0.0.1"}

func assertRedirectRefusedQuietly(t *testing.T, what string, err error, status int, location string, hits *atomic.Int32, secrets ...string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: %d accepted", what, status)
	}
	msg := err.Error()
	if !strings.Contains(msg, fmt.Sprint(status)) || !strings.Contains(msg, "redirect") {
		t.Fatalf("%s: error %q does not name status %d and redirect", what, msg, status)
	}
	parsed, _ := url.Parse(location)
	for _, leak := range append([]string{redirectLocationSentinel, redirectBodySentinel, parsed.Port(), "stolen"}, secrets...) {
		if strings.Contains(msg, leak) {
			t.Fatalf("%s: error %q leaks %q", what, msg, leak)
		}
	}
	if errors.Is(err, ErrLoginExpired) {
		t.Fatalf("%s: redirect reported as ErrLoginExpired: %v", what, err)
	}
	var tokenErr *TokenError
	if errors.As(err, &tokenErr) {
		t.Fatalf("%s: redirect reported as TokenError: %v", what, err)
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		t.Fatalf("%s: redirect reported as APIError: %v", what, err)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%s: redirect target got %d requests", what, n)
	}
}

func TestTokenEndpointRefusesEveryRedirectStatus(t *testing.T) {
	for _, status := range everyRedirectStatus {
		for _, host := range redirectHosts {
			t.Run(fmt.Sprintf("%d-%s", status, host), func(t *testing.T) {
				origin, location, hits := redirectPairWithBody(t, status, host)
				base, _ := url.Parse(origin.URL)
				transport := &hostTransport{host: "auth.openai.com", base: base, next: origin.Client().Transport}

				// A caller's client that WOULD follow redirects, with a
				// counting CheckRedirect: it must never be consulted or
				// replaced.
				var consulted atomic.Int32
				follow := func(*http.Request, []*http.Request) error { consulted.Add(1); return nil }
				mineBare := &http.Client{Transport: transport, CheckRedirect: follow}
				mineNew := &http.Client{Transport: transport, CheckRedirect: follow, Timeout: 7 * time.Second}
				wantPtr := reflect.ValueOf(follow).Pointer()

				clients := map[string]*Client{
					"bare Client":         {HTTP: mineBare},
					"NewClient":           NewClient(mineNew),
					"bare, no CheckRedir": {HTTP: &http.Client{Transport: transport}},
				}
				for name, c := range clients {
					_, err := c.Refresh(context.Background(), "rt-secret")
					assertRedirectRefusedQuietly(t, name+" Refresh", err, status, location, hits, "rt-secret")
					_, err = c.Exchange(context.Background(), "code-secret", &PKCE{Verifier: "verifier-secret", Challenge: "c"}, 1455)
					assertRedirectRefusedQuietly(t, name+" Exchange", err, status, location, hits, "code-secret", "verifier-secret")
				}
				if consulted.Load() != 0 {
					t.Fatalf("the caller's CheckRedirect ran %d times", consulted.Load())
				}
				for name, mine := range map[string]*http.Client{"bare": mineBare, "new": mineNew} {
					if mine.CheckRedirect == nil || reflect.ValueOf(mine.CheckRedirect).Pointer() != wantPtr {
						t.Fatalf("%s: the caller's http.Client.CheckRedirect was replaced", name)
					}
				}
				if mineNew.Timeout != 7*time.Second {
					t.Fatal("caller's Timeout changed")
				}
				if got := clients["NewClient"].HTTP; got == mineNew || got.Timeout != 7*time.Second || got.Transport != transport {
					t.Fatalf("NewClient did not copy the caller's settings: %+v", got)
				}
			})
		}
	}
}

func TestBackendRefusesEveryRedirectStatus(t *testing.T) {
	for _, status := range everyRedirectStatus {
		for _, host := range redirectHosts {
			t.Run(fmt.Sprintf("%d-%s", status, host), func(t *testing.T) {
				t.Setenv("CODEX_HOME", t.TempDir())
				origin, location, hits := redirectPairWithBody(t, status, host)
				store := NewStore(nil, StoreOptions{Dir: t.TempDir()})
				if err := store.Save(&Token{AccessToken: "secret-access", RefreshToken: "secret-refresh", AccountID: "acct", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
					t.Fatalf("Save: %v", err)
				}
				var consulted atomic.Int32
				follow := func(*http.Request, []*http.Request) error { consulted.Add(1); return nil }
				mine := origin.Client()
				mine.CheckRedirect = follow
				wantPtr := reflect.ValueOf(follow).Pointer()

				for name, backend := range map[string]*Backend{
					"NewBackend":   NewBackend(origin.URL, "ua", "orig", store, origin.Client().Transport),
					"bare Backend": {BaseURL: origin.URL, Store: store, HTTP: mine},
				} {
					resp, err := backend.Responses(context.Background(), []byte(`{}`), "")
					if resp != nil {
						_ = resp.Body.Close()
						t.Fatalf("%s: a response came back with the error", name)
					}
					assertRedirectRefusedQuietly(t, name, err, status, location, hits, "secret-access", "secret-refresh")
				}
				if consulted.Load() != 0 || reflect.ValueOf(mine.CheckRedirect).Pointer() != wantPtr {
					t.Fatal("the bare Backend's caller http.Client was consulted or mutated")
				}
			})
		}
	}
}

// Login callback: other methods, empty state and duplicated state params; the
// forged codes are never exchanged.
func TestLoginCallbackRefusesOtherMethodsAndStates(t *testing.T) {
	var exchanges atomic.Int32
	var gotCode atomic.Value
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		exchanges.Add(1)
		gotCode.Store(r.PostForm.Get("code"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"at","refresh_token":"rt","expires_in":3600}`))
	}))
	t.Cleanup(tokenServer.Close)
	client := &Client{HTTP: &http.Client{Transport: rewriteTo(tokenServer.URL)}}

	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()

	announced := make(chan string, 1)
	type outcome struct {
		result *LoginResult
		err    error
	}
	done := make(chan outcome, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() {
		r, err := client.Login(ctx, port, false, func(u string) { announced <- u })
		done <- outcome{r, err}
	}()
	var state string
	select {
	case u := <-announced:
		p, _ := url.Parse(u)
		state = p.Query().Get("state")
	case o := <-done:
		t.Fatalf("Login ended early: %v", o.err)
	}
	cb := fmt.Sprintf("http://127.0.0.1:%d/auth/callback", port)
	plain := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	good := url.QueryEscape(state)
	// Same length, last char flipped: exercises the comparison, not the length.
	flipped := []byte(state)
	if flipped[len(flipped)-1] == 'A' {
		flipped[len(flipped)-1] = 'B'
	} else {
		flipped[len(flipped)-1] = 'A'
	}
	for _, tc := range []struct {
		name, method, query string
		want                int
	}{
		{"PUT right state", http.MethodPut, "state=" + good + "&code=forged", 405},
		{"DELETE right state", http.MethodDelete, "state=" + good + "&code=forged", 405},
		{"PATCH right state", http.MethodPatch, "state=" + good + "&code=forged", 405},
		{"HEAD right state", http.MethodHead, "state=" + good + "&code=forged", 405},
		{"POST right state, error", http.MethodPost, "state=" + good + "&error=access_denied", 405},
		{"empty state with code", http.MethodGet, "state=&code=forged", 400},
		{"same-length wrong state", http.MethodGet, "state=" + url.QueryEscape(string(flipped)) + "&code=forged", 400},
		{"prefix of state", http.MethodGet, "state=" + url.QueryEscape(state[:len(state)-1]) + "&code=forged", 400},
		{"wrong state first, right second", http.MethodGet, "state=nope&state=" + good + "&code=forged", 400},
		{"wrong state, access_denied + code", http.MethodGet, "state=nope&error=access_denied&code=forged", 400},
		{"no params", http.MethodGet, "", 400},
	} {
		req, _ := http.NewRequest(tc.method, cb+"?"+tc.query, nil)
		resp, err := plain.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Fatalf("%s: status %d, want %d", tc.name, resp.StatusCode, tc.want)
		}
		if tc.want == 405 && resp.Header.Get("Allow") != http.MethodGet {
			t.Fatalf("%s: Allow = %q", tc.name, resp.Header.Get("Allow"))
		}
		select {
		case o := <-done:
			t.Fatalf("%s ended the login: %v", tc.name, o.err)
		case <-time.After(30 * time.Millisecond):
		}
	}
	if exchanges.Load() != 0 {
		t.Fatalf("a forged callback was exchanged (%d calls)", exchanges.Load())
	}
	resp, err := plain.Get(cb + "?state=" + good + "&code=real-code")
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("real callback got %d", resp.StatusCode)
	}
	o := <-done
	if o.err != nil || o.result.Token.AccessToken != "at" {
		t.Fatalf("Login = %+v, %v", o.result, o.err)
	}
	if exchanges.Load() != 1 || gotCode.Load() != "real-code" {
		t.Fatalf("exchanges = %d, code %v; want one exchange of real-code", exchanges.Load(), gotCode.Load())
	}
}

// Default lock path is <auth_dir>/codex.json.lock; an auth_file reached through
// a link locks beside its target; the old codex.lock is never created.
func TestLockSitsBesideTheCredentialFile(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	dir := t.TempDir()
	store := NewStore(nil, StoreOptions{Dir: dir})
	if want := filepath.Join(resolvePath(dir, 0), "codex.json.lock"); resolvePath(store.lockPath(), 0) != want {
		t.Fatalf("default lockPath = %s, want %s", store.lockPath(), want)
	}
	if err := store.Save(&Token{AccessToken: "at"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "codex.json.lock")); err != nil {
		t.Fatalf("no codex.json.lock after Save: %v", err)
	}
	// The legacy lock is held too, for one release, so an older binary on
	// the same file is excluded.
	if _, err := os.Stat(filepath.Join(dir, legacyLockName)); err != nil {
		t.Fatalf("no legacy codex.lock after Save: %v", err)
	}

	realDir, linkDir, authDir := t.TempDir(), t.TempDir(), t.TempDir()
	file := filepath.Join(realDir, "creds.json")
	writeNative(t, file, Token{AccessToken: "at", ExpiresAt: time.Now().Add(time.Hour)}, 0o600)
	link := filepath.Join(linkDir, "link.json")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	ls := NewStore(nil, StoreOptions{Dir: authDir, ExplicitPath: link})
	if got, want := ls.lockPath(), resolvePath(file, 0)+".lock"; got != want {
		t.Fatalf("lockPath via link = %s, want %s", got, want)
	}
	if err := ls.Save(&Token{AccessToken: "at2"}); err != nil {
		t.Fatalf("Save via link: %v", err)
	}
	if _, err := os.Stat(filepath.Join(authDir, legacyLockName)); err != nil {
		t.Fatalf("no legacy codex.lock in auth_dir: %v", err)
	}
	for _, unwanted := range []string{link + ".lock", filepath.Join(authDir, "codex.json.lock")} {
		if _, err := os.Lstat(unwanted); !os.IsNotExist(err) {
			t.Fatalf("unexpected lock %s: %v", unwanted, err)
		}
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("link replaced by Save: %v", err)
	}
}

// Five stores on one credential file, reached as the file, through a file
// symlink, through a symlinked directory and through a relative `..` path,
// each with its own auth_dir: one endpoint call per round, repeated.
func TestStoresReachingOneFileRotateOnce(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	for round := 0; round < 15; round++ {
		fake, client := newOAuthServer(t, 30*time.Millisecond)
		realDir := t.TempDir()
		file := filepath.Join(realDir, "creds.json")
		writeNative(t, file, Token{AccessToken: "stale", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(-time.Minute)}, 0o600)
		fileLink := filepath.Join(t.TempDir(), "creds-link.json")
		if err := os.Symlink(file, fileLink); err != nil {
			t.Fatal(err)
		}
		dirLink := filepath.Join(t.TempDir(), "dirlink")
		if err := os.Symlink(realDir, dirLink); err != nil {
			t.Fatal(err)
		}
		dotted := filepath.Join(realDir, "sub", "..", "creds.json")
		if err := os.MkdirAll(filepath.Join(realDir, "sub"), 0o700); err != nil {
			t.Fatal(err)
		}
		paths := []string{file, file, fileLink, filepath.Join(dirLink, "creds.json"), dotted}
		stores := make([]*Store, len(paths))
		for i, p := range paths {
			stores[i] = NewStore(client, StoreOptions{Dir: t.TempDir(), ExplicitPath: p})
			if _, err := stores[i].Peek(); err != nil {
				t.Fatalf("Peek %d: %v", i, err)
			}
			if stores[i].lockPath() != stores[0].lockPath() {
				t.Fatalf("store %d (%s) locks %s, store 0 locks %s", i, p, stores[i].lockPath(), stores[0].lockPath())
			}
		}
		start := make(chan struct{})
		results := make([]string, len(stores))
		errs := make([]error, len(stores))
		var wg sync.WaitGroup
		for i, s := range stores {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				results[i], _, errs[i] = s.Access(context.Background())
			}()
		}
		close(start)
		wg.Wait()
		for i := range stores {
			if errs[i] != nil || results[i] != "access-from-rt-1" {
				t.Fatalf("round %d store %d: %q, %v", round, i, results[i], errs[i])
			}
		}
		if n := fake.calls.Load(); n != 1 {
			t.Fatalf("round %d: token endpoint called %d times, want 1", round, n)
		}
		for _, l := range []string{fileLink, dirLink} {
			if info, err := os.Lstat(l); err != nil || info.Mode()&os.ModeSymlink == 0 {
				t.Fatalf("round %d: %s is no longer a symlink: %v", round, l, err)
			}
		}
	}
}

// The store reached through the symlink is the one that refreshes: the
// write goes through to the target and the link stays a link.
func TestRefreshThroughSymlinkKeepsTheLink(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	fake, client := newOAuthServer(t, 0)
	file := filepath.Join(t.TempDir(), "creds.json")
	writeNative(t, file, Token{AccessToken: "stale", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(-time.Minute)}, 0o600)
	link := filepath.Join(t.TempDir(), "link.json")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	s := NewStore(client, StoreOptions{Dir: t.TempDir(), ExplicitPath: link})
	at, _, err := s.Access(context.Background())
	if err != nil || at != "access-from-rt-1" {
		t.Fatalf("Access = %q, %v", at, err)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("link replaced: %v", err)
	}
	tok, err := NewStore(nil, StoreOptions{Dir: t.TempDir(), ExplicitPath: file}).Peek()
	if err != nil || tok.RefreshToken != "rt-2" {
		t.Fatalf("target not updated: %+v %v", tok, err)
	}
	if info, _ := os.Stat(file); info.Mode().Perm() != 0o600 {
		t.Fatalf("target mode %v", info.Mode().Perm())
	}
	if fake.calls.Load() != 1 {
		t.Fatalf("calls = %d", fake.calls.Load())
	}
}
