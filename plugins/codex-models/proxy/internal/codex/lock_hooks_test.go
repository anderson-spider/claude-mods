package codex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

// While a store waits on the locks, another process refreshes the file: the
// new credential has the same size and the file keeps its old mtime (a coarse
// file system, or a writer that restores it), so the stamp does not move.
// Under the locks the store still reads the file again: it serves the new
// token and never spends the old refresh token, so the one refresh made is
// the other process's.
func TestRefreshRereadsTheFileUnderTheLocks(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"spent","refresh_token":"spent","expires_in":3600}`))
	}))
	t.Cleanup(server.Close)

	dir := t.TempDir()
	path := filepath.Join(dir, nativeFileName)
	base := time.Now().UTC().Truncate(time.Second)
	encode := func(access, refresh string, expires time.Time) []byte {
		data, err := json.Marshal(Token{AccessToken: access, RefreshToken: refresh, AccountID: "acct",
			ExpiresAt: expires, LastRefresh: base, Type: tokenType})
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	// The old token is inside the refresh lead; the new one has hours left.
	old := encode("access-old-1", "rt-old-1", base.Add(time.Minute))
	renewed := encode("access-new-1", "rt-new-1", base.Add(3*time.Hour))
	if len(old) != len(renewed) {
		t.Fatalf("the two files must have one size: %d and %d", len(old), len(renewed))
	}
	if err := os.WriteFile(path, old, 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	store := NewStore(&Client{HTTP: &http.Client{Transport: rewriteTo(server.URL)}}, StoreOptions{Dir: dir})
	releaseLegacy := holdLock(t, store.legacyLockPath())
	releaseCurrent := holdLock(t, store.lockPath())
	var rewrote atomic.Bool
	lockBusy = func() {
		if rewrote.Swap(true) {
			return
		}
		// The other process, holding the locks: it writes its refreshed
		// credential, puts the mtime back, and lets go.
		if err := os.WriteFile(path, renewed, 0o600); err != nil {
			t.Error(err)
		}
		if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
			t.Error(err)
		}
		if now := stampOf(path); now != (fileStamp{size: info.Size(), modTime: info.ModTime()}) {
			t.Errorf("the stamp moved (%+v); the test needs it unchanged", now)
		}
		releaseCurrent()
		releaseLegacy()
	}
	t.Cleanup(func() { lockBusy = nil })

	access, account, err := store.Access(context.Background())
	if err != nil {
		t.Fatalf("Access: %v", err)
	}
	if !rewrote.Load() {
		t.Fatal("the store never waited on the locks")
	}
	if access != "access-new-1" || account != "acct" {
		t.Fatalf("Access = %q, %q; want the credential the other process wrote", access, account)
	}
	if n := calls.Load(); n != 0 {
		t.Fatalf("the token endpoint was called %d times; the old refresh token was spent", n)
	}
}

// The two locks are released in reverse order: the one beside the file
// first, the legacy one last.
func TestLocksAreReleasedInReverseOrder(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	store := NewStore(nil, StoreOptions{Dir: t.TempDir()})
	legacy, current := store.legacyLockPath(), store.lockPath()
	if sameFile(legacy, current) {
		t.Fatal("the default layout must have two lock files")
	}
	var released []string
	lockReleased = func(path string) { released = append(released, path) }
	t.Cleanup(func() { lockReleased = nil })

	unlock, err := store.lock(context.Background())
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	if len(released) != 0 {
		t.Fatalf("released while held: %v", released)
	}
	unlock()
	if want := []string{current, legacy}; !slices.Equal(released, want) {
		t.Fatalf("released %v, want %v", released, want)
	}

	// A failure on the second lock releases the first.
	released = nil
	holdLock(t, current)
	ctx, cancel := context.WithCancel(context.Background())
	lockBusy = func() { cancel() }
	t.Cleanup(func() { lockBusy = nil })
	if _, err := store.lock(ctx); err == nil {
		t.Fatal("lock succeeded with the file lock held elsewhere")
	}
	if want := []string{legacy}; !slices.Equal(released, want) {
		t.Fatalf("released %v after a failed lock, want %v", released, want)
	}
}
