package codex

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// holdLock takes an exclusive flock on path from its own descriptor, as
// another process would, and returns its release.
func holdLock(t *testing.T, path string) func() {
	t.Helper()
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatalf("flock %s: %v", path, err)
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
			_ = file.Close()
		})
	}
	t.Cleanup(release)
	return release
}

// lockIsFree reports whether path can be flocked right now; it never
// creates the file.
func lockIsFree(t *testing.T, path string) bool {
	t.Helper()
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if os.IsNotExist(err) {
		return true
	}
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer file.Close()
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return false
	}
	_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return true
}

// eventually polls cond for up to two seconds.

// Through the backend: a non-2xx is an APIError whose text has no body, only
// short type and code, and whose Body is intact for the router.
func TestBackendErrorTextKeepsTheBodyOnTheStructOnly(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		want   string
	}{
		{429, `{"error":{"type":"rate_limit","code":"usage_limit_reached","message":"SECRET sk-abc"}}`, "codex: backend returned 429 (type rate_limit, code usage_limit_reached)"},
		{400, `{"error":{"code":"bad_code","message":"SECRET"}}`, "codex: backend returned 400 (code bad_code)"},
		{400, `{"error":{"type":"` + strings.Repeat("a", 65) + `","code":7}}`, "codex: backend returned 400"},
		{400, `{"error":{"type":"x\ny","code":"SECRET token"}}`, "codex: backend returned 400"},
		{500, `{"error":"SECRET-flat"}`, "codex: backend returned 500"},
		{502, "", "codex: backend returned 502"},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		store := NewStore(nil, StoreOptions{Dir: t.TempDir()})
		if err := store.Save(&Token{AccessToken: "secret-access", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		_, err := NewBackend(server.URL, store, nil).Responses(context.Background(), []byte(`{}`), "")
		server.Close()
		var apiErr *APIError
		if !errors.As(err, &apiErr) {
			t.Fatalf("%d: err = %v, want APIError", tc.status, err)
		}
		if err.Error() != tc.want {
			t.Fatalf("Error() = %q, want %q", err.Error(), tc.want)
		}
		if strings.Contains(err.Error(), "SECRET") || strings.Contains(err.Error(), "secret-access") {
			t.Fatalf("Error() leaks: %q", err.Error())
		}
		if apiErr.StatusCode != tc.status || string(apiErr.Body) != tc.body {
			t.Fatalf("struct = %d %q, want %d %q", apiErr.StatusCode, apiErr.Body, tc.status, tc.body)
		}
	}
}

func TestCredentialLockReleasedAfterMutationFailures(t *testing.T) {
	store := NewStore(nil, StoreOptions{Dir: t.TempDir()})
	// A nonempty directory at the credential basename makes both rename and
	// removal fail after lock acquisition, without changing the obstruction.
	if err := os.Mkdir(store.NativePath(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.NativePath(), "keep"), []byte("kept"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(&Token{AccessToken: "new"}); err == nil {
		t.Fatal("Save should fail")
	}
	if !lockIsFree(t, store.lockPath()) {
		t.Fatal("Save left the lock held")
	}
	if _, err := store.Remove(); err == nil {
		t.Fatal("Remove should fail")
	}
	if !lockIsFree(t, store.lockPath()) {
		t.Fatal("Remove left the lock held")
	}
	fake, client := newOAuthServer(t, 0)
	refreshStore := NewStore(client, StoreOptions{Dir: t.TempDir()})
	if err := refreshStore.Save(&Token{RefreshToken: "rt-1", ExpiresAt: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := refreshStore.Access(context.Background()); err != nil {
		t.Fatal(err)
	}
	if fake.calls.Load() != 1 || !lockIsFree(t, refreshStore.lockPath()) {
		t.Fatal("refresh did not release the lock")
	}
	expired, calls := expiredOwnLogin(t, 400, `{"error":"invalid_grant"}`)
	if _, _, err := expired.Access(context.Background()); !errors.Is(err, ErrLoginExpired) {
		t.Fatalf("refresh = %v", err)
	}
	if calls.Load() != 1 || !lockIsFree(t, expired.lockPath()) {
		t.Fatal("failed refresh kept the lock")
	}
}
