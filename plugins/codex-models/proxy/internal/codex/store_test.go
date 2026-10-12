package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// oauthServer is a fake token endpoint that counts refreshes and, like the
// real one, refuses a refresh token that was already spent.
type oauthServer struct {
	calls atomic.Int32
	mu    sync.Mutex
	spent map[string]bool
	// next is the refresh token handed out by the next refresh.
	next  string
	delay time.Duration
}

func newOAuthServer(t *testing.T, delay time.Duration) (*oauthServer, *Client) {
	t.Helper()
	fake := &oauthServer{spent: map[string]bool{}, next: "rt-2", delay: delay}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.calls.Add(1)
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
		}
		time.Sleep(fake.delay)
		refresh := r.PostForm.Get("refresh_token")
		fake.mu.Lock()
		reused := fake.spent[refresh]
		fake.spent[refresh] = true
		next := fake.next
		fake.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if reused {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"refresh_token_reused"}`))
			return
		}
		_, _ = fmt.Fprintf(w, `{"access_token":%q,"refresh_token":%q,"expires_in":3600}`,
			"access-from-"+refresh, next)
	}))
	t.Cleanup(server.Close)
	return fake, &Client{HTTP: &http.Client{Transport: rewriteTo(server.URL)}}
}

// snapshot is everything about a file that a write or removal would change.
func writeNative(t *testing.T, path string, token Token, mode os.FileMode) {
	t.Helper()
	data, err := json.Marshal(token)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestAtomicWriteTightensAnExistingFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "auth")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	path := filepath.Join(dir, "codex.json")
	writeNative(t, path, Token{AccessToken: "old"}, 0o644)
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("chmod: %v", err)
	}

	store := NewStore(nil, StoreOptions{Dir: dir})
	if err := store.Save(&Token{AccessToken: "new", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("credential file mode = %o, want 600", mode)
	}
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("auth dir mode = %v (%v), want 700", info.Mode().Perm(), err)
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
	if token, err := NewStore(nil, StoreOptions{Dir: dir}).Peek(); err != nil || token.AccessToken != "new" {
		t.Fatalf("reloaded token = %+v, %v", token, err)
	}
}

func TestAtomicWriteCreatesThePrivateDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "a", "auth")
	store := NewStore(nil, StoreOptions{Dir: dir})
	if err := store.Save(&Token{AccessToken: "at"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("auth dir = %v, %v; want mode 700", info, err)
	}
}

// Two proxies sharing an auth dir, both finding the token expired, spend the
// refresh token once: the second waits for the lock and reads the first's.
func TestConcurrentRefreshRotatesOnce(t *testing.T) {
	fake, client := newOAuthServer(t, 100*time.Millisecond)
	dir := t.TempDir()
	writeNative(t, filepath.Join(dir, "codex.json"),
		Token{AccessToken: "stale", RefreshToken: "rt-1", AccountID: "acct", ExpiresAt: time.Now().Add(-time.Minute)}, 0o600)

	first := NewStore(client, StoreOptions{Dir: dir})
	second := NewStore(client, StoreOptions{Dir: dir})
	for _, store := range []*Store{first, second} {
		if _, err := store.Peek(); err != nil {
			t.Fatalf("Peek: %v", err)
		}
	}

	start := make(chan struct{})
	results := make([]string, 2)
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i, store := range []*Store{first, second} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results[i], _, errs[i] = store.Access(context.Background())
		}()
	}
	close(start)
	wg.Wait()

	for i := range results {
		if errs[i] != nil {
			t.Fatalf("store %d: %v", i, errs[i])
		}
		if results[i] != "access-from-rt-1" {
			t.Fatalf("store %d got %q, want the one refreshed token", i, results[i])
		}
	}
	if n := fake.calls.Load(); n != 1 {
		t.Fatalf("token endpoint called %d times, want 1", n)
	}
	token, err := NewStore(nil, StoreOptions{Dir: dir}).Peek()
	if err != nil || token.RefreshToken != "rt-2" {
		t.Fatalf("stored token = %+v, %v; want the rotated refresh token", token, err)
	}
}

// A token another instance writes while this one waits for the lock is used
// as is, without a refresh.
func TestRefreshRereadsTheFileUnderTheLock(t *testing.T) {
	fake, client := newOAuthServer(t, 0)
	dir := t.TempDir()
	path := filepath.Join(dir, "codex.json")
	writeNative(t, path, Token{AccessToken: "stale", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(-time.Minute)}, 0o600)

	// Another instance holds the lock, mid-refresh.
	held, err := os.OpenFile(path+lockSuffix, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatalf("open lock: %v", err)
	}
	defer held.Close()
	if err := syscall.Flock(int(held.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatalf("flock: %v", err)
	}

	store := NewStore(client, StoreOptions{Dir: dir})
	type result struct {
		access string
		err    error
	}
	done := make(chan result, 1)
	go func() {
		access, _, err := store.Access(context.Background())
		done <- result{access, err}
	}()

	select {
	case <-time.After(100 * time.Millisecond):
	case r := <-done:
		t.Fatalf("Access returned without waiting for the lock: %+v", r)
	}

	// The other instance finishes: a fresh token on disk, then the unlock.
	writeNative(t, path, Token{AccessToken: "from-the-other", RefreshToken: "rt-9", ExpiresAt: time.Now().Add(time.Hour)}, 0o600)
	if err := syscall.Flock(int(held.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatalf("unlock: %v", err)
	}

	r := <-done
	if r.err != nil {
		t.Fatalf("Access: %v", r.err)
	}
	if r.access != "from-the-other" {
		t.Fatalf("access = %q, want the token the other instance wrote", r.access)
	}
	if n := fake.calls.Load(); n != 0 {
		t.Fatalf("token endpoint called %d times, want none", n)
	}
}

func mustGetwd(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	return wd
}

// expiredOwnLogin writes an expired own login and returns a store over it
// whose token endpoint answers status with body.
func expiredOwnLogin(t *testing.T, status int, body string) (*Store, *atomic.Int32) {
	t.Helper()
	calls := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	writeNative(t, filepath.Join(dir, "codex.json"),
		Token{AccessToken: "stale", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(-time.Minute)}, 0o600)
	return NewStore(&Client{HTTP: &http.Client{Transport: rewriteTo(server.URL)}}, StoreOptions{Dir: dir}), calls
}

// A refresh the token endpoint refuses is a lost login: ErrLoginExpired,
// naming the fix, with the status and OAuth code but never the body.
func TestRejectedRefreshIsLoginExpired(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		code   string
	}{
		{http.StatusBadRequest, `{"error":"invalid_grant","error_description":"echo rt-1 SECRET"}`, "invalid_grant"},
		{http.StatusBadRequest, `{"error":"refresh_token_reused","error_description":"SECRET"}`, "refresh_token_reused"},
		{http.StatusUnauthorized, `{"error":"invalid_client"}`, "invalid_client"},
		{http.StatusForbidden, `SECRET plain text`, ""},
		// Not a short token: the code is dropped rather than echoed.
		{http.StatusBadRequest, `{"error":"SECRET with spaces, which no OAuth code has"}`, ""},
		{http.StatusBadRequest, `{"error":{"message":"SECRET"}}`, ""},
	} {
		t.Run(fmt.Sprintf("%d %s", tc.status, tc.code), func(t *testing.T) {
			store, calls := expiredOwnLogin(t, tc.status, tc.body)
			_, _, err := store.Access(context.Background())
			if !errors.Is(err, ErrLoginExpired) {
				t.Fatalf("Access = %v, want ErrLoginExpired", err)
			}
			var tokenErr *TokenError
			if !errors.As(err, &tokenErr) || tokenErr.StatusCode != tc.status || tokenErr.Code != tc.code {
				t.Fatalf("TokenError = %+v, want status %d code %q", tokenErr, tc.status, tc.code)
			}
			message := err.Error()
			for _, want := range []string{"`ccmproxy login codex`", fmt.Sprint(tc.status), tc.code} {
				if !strings.Contains(message, want) {
					t.Fatalf("error %q does not name %q", message, want)
				}
			}
			if strings.Contains(message, "SECRET") || strings.Contains(message, "rt-1") {
				t.Fatalf("error %q repeats the response body", message)
			}
			if calls.Load() != 1 {
				t.Fatalf("token endpoint called %d times", calls.Load())
			}
		})
	}
}

// A failure that may pass (a 5xx, a 429, the network) is not a lost login.
func TestTransientRefreshFailureIsNotLoginExpired(t *testing.T) {
	for _, status := range []int{http.StatusInternalServerError, http.StatusBadGateway, http.StatusTooManyRequests} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			store, _ := expiredOwnLogin(t, status, `{"error":"server_error","error_description":"SECRET"}`)
			_, _, err := store.Access(context.Background())
			if err == nil || errors.Is(err, ErrLoginExpired) {
				t.Fatalf("Access = %v, want a transient error, not ErrLoginExpired", err)
			}
			var tokenErr *TokenError
			if !errors.As(err, &tokenErr) || tokenErr.StatusCode != status {
				t.Fatalf("TokenError = %+v, want status %d", tokenErr, status)
			}
			if strings.Contains(err.Error(), "SECRET") {
				t.Fatalf("error %q repeats the response body", err)
			}
		})
	}

	t.Run("network", func(t *testing.T) {
		server := httptest.NewServer(http.NotFoundHandler())
		base := server.URL
		server.Close()
		dir := t.TempDir()
		writeNative(t, filepath.Join(dir, "codex.json"),
			Token{AccessToken: "stale", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(-time.Minute)}, 0o600)
		store := NewStore(&Client{HTTP: &http.Client{Transport: rewriteTo(base)}}, StoreOptions{Dir: dir})
		_, _, err := store.Access(context.Background())
		if err == nil || errors.Is(err, ErrLoginExpired) {
			t.Fatalf("Access = %v, want a network error, not ErrLoginExpired", err)
		}
	})
}

// A rejected refresh with the current token still valid keeps serving it.
func TestRejectedRefreshKeepsAStillValidToken(t *testing.T) {
	store, _ := expiredOwnLogin(t, http.StatusBadRequest, `{"error":"invalid_grant"}`)
	if err := store.Save(&Token{AccessToken: "still-valid", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(time.Minute)}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if access, _, err := store.Access(context.Background()); err != nil || access != "still-valid" {
		t.Fatalf("Access = %q, %v; want the still-valid token", access, err)
	}
}

// captureStderr runs fn with os.Stderr, where logx writes, sent to a pipe.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	saved := os.Stderr
	os.Stderr = w
	fn()
	os.Stderr = saved
	_ = w.Close()
	out, _ := io.ReadAll(r)
	return string(out)
}

// A refresh the endpoint rejected is not sent again for the same credential:
// a still-valid access token keeps serving, an expired one answers
// ErrLoginExpired at once. The rejection is logged once, with the status and
// OAuth code only. A change to the file (a new login, another instance)
// allows a refresh again.
func TestRejectedRefreshIsNotRetriedUntilTheFileChanges(t *testing.T) {
	for _, tc := range []struct {
		name      string
		expiresIn time.Duration
	}{
		{"access token still valid", time.Minute},
		{"access token expired", -time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls, status atomic.Int32
			status.Store(http.StatusBadRequest)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if code := int(status.Load()); code != http.StatusOK {
					w.WriteHeader(code)
					_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"SECRET rt-1"}`))
					return
				}
				_, _ = w.Write([]byte(`{"access_token":"renewed","refresh_token":"rt-2","expires_in":3600}`))
			}))
			t.Cleanup(server.Close)

			dir := t.TempDir()
			path := filepath.Join(dir, "codex.json")
			writeNative(t, path, Token{AccessToken: "own-access", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(tc.expiresIn)}, 0o600)
			store := NewStore(&Client{HTTP: &http.Client{Transport: rewriteTo(server.URL)}}, StoreOptions{Dir: dir})

			logged := captureStderr(t, func() {
				for i := 0; i < 3; i++ {
					access, _, err := store.Access(context.Background())
					if tc.expiresIn > 0 {
						if err != nil || access != "own-access" {
							t.Fatalf("request %d: Access = %q, %v; want the still-valid token", i, access, err)
						}
						continue
					}
					if !errors.Is(err, ErrLoginExpired) || !strings.Contains(err.Error(), "`ccmproxy login codex`") {
						t.Fatalf("request %d: Access = %v, want ErrLoginExpired naming the fix", i, err)
					}
				}
			})
			if n := calls.Load(); n != 1 {
				t.Fatalf("token endpoint called %d times for 3 requests, want 1", n)
			}
			var lines []string
			for _, line := range strings.Split(logged, "\n") {
				if strings.Contains(line, "rejected the refresh") {
					lines = append(lines, line)
				}
			}
			if len(lines) != 1 {
				t.Fatalf("rejection logged %d times, want once:\n%s", len(lines), logged)
			}
			if !strings.Contains(lines[0], "status 400") || !strings.Contains(lines[0], "error invalid_grant") {
				t.Fatalf("log line %q lacks the status or the OAuth code", lines[0])
			}
			if strings.Contains(logged, "SECRET") || strings.Contains(logged, "rt-1") || strings.Contains(logged, "own-access") {
				t.Fatalf("the log repeats a body or a token:\n%s", logged)
			}

			// The file changes (same credential, new stamp): refresh is tried again.
			status.Store(http.StatusOK)
			writeNative(t, path, Token{AccessToken: "own-access", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(-time.Minute)}, 0o600)
			later := time.Now().Add(2 * time.Second)
			if err := os.Chtimes(path, later, later); err != nil {
				t.Fatalf("chtimes: %v", err)
			}
			access, _, err := store.Access(context.Background())
			if err != nil || access != "renewed" {
				t.Fatalf("after the file changed: Access = %q, %v; want a refresh", access, err)
			}
			if n := calls.Load(); n != 2 {
				t.Fatalf("token endpoint called %d times, want 2", n)
			}
		})
	}
}

// A new login through this store clears the rejection at once.
func TestSaveClearsARejectedRefresh(t *testing.T) {
	store, calls := expiredOwnLogin(t, http.StatusBadRequest, `{"error":"invalid_grant"}`)
	if _, _, err := store.Access(context.Background()); !errors.Is(err, ErrLoginExpired) {
		t.Fatalf("Access = %v, want ErrLoginExpired", err)
	}
	if err := store.Save(&Token{AccessToken: "fresh", RefreshToken: "rt-new", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if access, _, err := store.Access(context.Background()); err != nil || access != "fresh" {
		t.Fatalf("Access after login = %q, %v", access, err)
	}
	if store.rejected != nil {
		t.Fatal("the rejection outlived a new login")
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("token endpoint called %d times, want 1", n)
	}
}

// Waiting is cancelled without leaving a lock held; competing stores all
// acquire and release the same exclusive credential lock.
func TestLocksAreReleasedOnEveryPath(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(nil, StoreOptions{Dir: dir})

	// A bounded cancellation closes the waiting descriptor.
	held, err := os.OpenFile(store.lockPath(), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer held.Close()
	if err := syscall.Flock(int(held.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatalf("flock: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := store.lock(ctx); err == nil {
		t.Fatal("lock succeeded while the credential lock was held")
	}
	_ = syscall.Flock(int(held.Fd()), syscall.LOCK_UN)

	// Concurrent stores on one dir all get through.
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			unlock, err := NewStore(nil, StoreOptions{Dir: dir}).lock(context.Background())
			if err != nil {
				t.Errorf("lock: %v", err)
				return
			}
			time.Sleep(5 * time.Millisecond)
			unlock()
		}()
	}
	wg.Wait()

}

// auth_dir reached through a symlink, before the credential file exists:
// the lock and the write target already name what a store resolves later.
func TestLockThroughALinkedAuthDirMatchesBeforeTheFileExists(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "auth-link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	viaLink := NewStore(nil, StoreOptions{Dir: link})
	viaReal := NewStore(nil, StoreOptions{Dir: real})
	before := viaLink.lockPath()
	if before != viaReal.lockPath() {
		t.Fatalf("before the file: lock via link %s, via real dir %s", before, viaReal.lockPath())
	}
	if writeTarget(viaLink.NativePath()) != writeTarget(viaReal.NativePath()) {
		t.Fatalf("write targets differ: %s and %s", writeTarget(viaLink.NativePath()), writeTarget(viaReal.NativePath()))
	}
	if err := viaLink.Save(&Token{AccessToken: "at"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if after := NewStore(nil, StoreOptions{Dir: link}).lockPath(); after != before {
		t.Fatalf("lock moved once the file existed: %s, then %s", before, after)
	}
}

// APIError's text carries the status and short type and code, never the body.
func TestAPIErrorTextLeavesTheBodyOut(t *testing.T) {
	for _, tc := range []struct {
		body string
		want string
	}{
		{`{"error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"SECRET prompt"}}`,
			"codex: backend returned 400 (type invalid_request_error, code context_length_exceeded)"},
		{`{"error":{"type":"SECRET with spaces","message":"SECRET"}}`, "codex: backend returned 400"},
		{`{"detail":"SECRET"}`, "codex: backend returned 400"},
		{`SECRET plain`, "codex: backend returned 400"},
	} {
		err := &APIError{StatusCode: 400, Body: []byte(tc.body)}
		if got := err.Error(); got != tc.want {
			t.Fatalf("Error() = %q, want %q", got, tc.want)
		}
		if string(err.Body) != tc.body {
			t.Fatal("the body is no longer on the struct")
		}
	}
}
