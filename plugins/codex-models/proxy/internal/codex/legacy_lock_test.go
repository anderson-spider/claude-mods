package codex

// The two login locks: the legacy <auth_dir>/codex.lock first, then the one
// beside the credential file; their order seen from outside, their release on
// failure, many auth_dirs on one file, CODEX_HOME left alone, and APIError's
// text.

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
func eventually(cond func() bool) bool {
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if cond() {
			return true
		}
	}
	return false
}

// Seen from outside: while the legacy lock is held by someone else, the store
// has not taken the lock beside the file; while the lock beside the file is
// held, the store already holds the legacy one. So the legacy one comes first.
func TestLegacyLockIsTakenBeforeTheFileLock(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	authDir, fileDir := t.TempDir(), t.TempDir()
	file := filepath.Join(fileDir, "creds.json")
	writeNative(t, file, Token{AccessToken: "at", ExpiresAt: time.Now().Add(time.Hour)}, 0o600)
	store := NewStore(nil, StoreOptions{Dir: authDir, ExplicitPath: file})
	legacy, current := store.legacyLockPath(), store.lockPath()
	if sameFile(legacy, current) {
		t.Fatalf("legacy %s and current %s should differ here", legacy, current)
	}

	// 1. Someone holds the legacy lock: the store waits there and leaves
	//    the file's lock alone.
	releaseLegacy := holdLock(t, legacy)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		unlock, err := store.lock(ctx)
		if unlock != nil {
			unlock()
		}
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	if !lockIsFree(t, current) {
		t.Fatal("the lock beside the file was taken while the legacy lock was still awaited")
	}
	if err := <-done; err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lock = %v, want a context deadline on the legacy lock", err)
	}
	releaseLegacy()

	// 2. Someone holds the lock beside the file: the store takes the legacy
	//    one, then waits; a deadline there releases the legacy one.
	releaseCurrent := holdLock(t, current)
	ctx2, cancel2 := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel2()
	go func() {
		unlock, err := store.lock(ctx2)
		if unlock != nil {
			unlock()
		}
		done <- err
	}()
	if !eventually(func() bool { return !lockIsFree(t, legacy) }) {
		t.Fatal("the store did not hold the legacy lock while waiting for the file's lock")
	}
	if err := <-done; err == nil || !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), current) {
		t.Fatalf("lock = %v, want a context deadline naming %s", err, current)
	}
	if !lockIsFree(t, legacy) {
		t.Fatal("the legacy lock stayed held after the second lock failed")
	}
	releaseCurrent()

	// 3. Both free: both are taken, then both released.
	unlock, err := store.lock(context.Background())
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	if lockIsFree(t, legacy) || lockIsFree(t, current) {
		t.Fatal("lock returned without holding both")
	}
	unlock()
	if !lockIsFree(t, legacy) || !lockIsFree(t, current) {
		t.Fatal("unlock left a lock held")
	}
}

// A context already done on the first lock never touches the second.
func TestFailureOnTheLegacyLockNeverTakesTheFileLock(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	authDir := t.TempDir()
	file := filepath.Join(t.TempDir(), "creds.json")
	store := NewStore(nil, StoreOptions{Dir: authDir, ExplicitPath: file})
	holdLock(t, store.legacyLockPath())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.lock(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("lock = %v, want context.Canceled", err)
	}
	if _, err := os.Lstat(store.lockPath()); !os.IsNotExist(err) {
		t.Fatalf("the file's lock was created although the legacy lock failed: %v", err)
	}
}

// Eight stores of this release, each with its own auth_dir (so each its own
// legacy lock), on one credential file reached by path, link and linked dir,
// with an older binary holding one of the legacy locks for a while: no
// deadlock, one endpoint call per round, every store served.
func TestManyAuthDirsOnOneFileNeitherDeadlockNorRotateTwice(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	for round := 0; round < 10; round++ {
		fake, client := newOAuthServer(t, 20*time.Millisecond)
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
		paths := []string{file, file, file, fileLink, fileLink, filepath.Join(dirLink, "creds.json"), file, fileLink}
		stores := make([]*Store, len(paths))
		legacies := map[string]bool{}
		for i, p := range paths {
			stores[i] = NewStore(client, StoreOptions{Dir: t.TempDir(), ExplicitPath: p})
			legacies[stores[i].legacyLockPath()] = true
			if stores[i].lockPath() != stores[0].lockPath() {
				t.Fatalf("store %d locks %s, store 0 %s", i, stores[i].lockPath(), stores[0].lockPath())
			}
		}
		if len(legacies) != len(stores) {
			t.Fatalf("legacy locks are not distinct: %v", legacies)
		}
		// An older binary on stores[0]'s auth_dir holds its legacy lock briefly.
		releaseOld := holdLock(t, stores[0].legacyLockPath())
		go func() { time.Sleep(50 * time.Millisecond); releaseOld() }()

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		start := make(chan struct{})
		results := make([]string, len(stores))
		errs := make([]error, len(stores))
		var wg sync.WaitGroup
		for i, s := range stores {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				results[i], _, errs[i] = s.Access(ctx)
			}()
		}
		close(start)
		finished := make(chan struct{})
		go func() { wg.Wait(); close(finished) }()
		select {
		case <-finished:
		case <-time.After(15 * time.Second):
			t.Fatalf("round %d: stores still waiting after 15 s (deadlock)", round)
		}
		cancel()
		for i := range stores {
			if errs[i] != nil || results[i] != "access-from-rt-1" {
				t.Fatalf("round %d store %d: %q, %v", round, i, results[i], errs[i])
			}
		}
		if n := fake.calls.Load(); n != 1 {
			t.Fatalf("round %d: token endpoint called %d times, want 1", round, n)
		}
		for _, s := range stores {
			if !lockIsFree(t, s.legacyLockPath()) || !lockIsFree(t, s.lockPath()) {
				t.Fatalf("round %d: a lock stayed held", round)
			}
		}
	}
}

// Refused configurations leave no lock, legacy or not, in CODEX_HOME.
func TestNoLockLandsInCodexHome(t *testing.T) {
	home, _ := cliHome(t, time.Hour)
	homeLink := filepath.Join(t.TempDir(), "home-link")
	if err := os.Symlink(home, homeLink); err != nil {
		t.Fatal(err)
	}
	for name, options := range map[string]StoreOptions{
		"auth_dir is CODEX_HOME":            {Dir: home},
		"auth_dir links to CODEX_HOME":      {Dir: homeLink},
		"auth_file in CODEX_HOME, no dir":   {ExplicitPath: filepath.Join(home, "proxy.json")},
		"auth_file via link, no dir":        {ExplicitPath: filepath.Join(homeLink, "proxy.json")},
		"auth_file named codex in the home": {Dir: t.TempDir(), ExplicitPath: filepath.Join(home, "codex")},
	} {
		t.Run(name, func(t *testing.T) {
			fake, client := newOAuthServer(t, 0)
			store := NewStore(client, options)
			if err := store.Save(&Token{AccessToken: "x", RefreshToken: "y"}); !errors.Is(err, ErrInsideCodexHome) {
				t.Fatalf("Save = %v, want ErrInsideCodexHome", err)
			}
			if _, _, err := store.Access(context.Background()); !errors.Is(err, ErrInsideCodexHome) {
				t.Fatalf("Access = %v, want ErrInsideCodexHome", err)
			}
			if _, err := store.lock(context.Background()); !errors.Is(err, ErrInsideCodexHome) {
				t.Fatalf("lock = %v, want ErrInsideCodexHome", err)
			}
			entries, _ := os.ReadDir(home)
			for _, entry := range entries {
				if strings.HasSuffix(entry.Name(), ".lock") {
					t.Fatalf("a lock was created in CODEX_HOME: %s", entry.Name())
				}
			}
			if fake.calls.Load() != 0 {
				t.Fatalf("token endpoint called %d times", fake.calls.Load())
			}
		})
	}
}

// Through the backend: a non-2xx is an APIError whose text has no body, only
// short type and code, and whose Body is intact for the router.
func TestBackendErrorTextKeepsTheBodyOnTheStructOnly(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
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
		_, err := NewBackend(server.URL, "ua", "o", store, nil).Responses(context.Background(), []byte(`{}`), "")
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
