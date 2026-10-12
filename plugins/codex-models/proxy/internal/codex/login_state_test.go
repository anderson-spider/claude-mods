package codex

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// A refresh holds the store for the token endpoint's round trip; Authenticated
// answers meanwhile from the state the refresh's own load left.
func TestAuthenticatedDoesNotWaitForARefresh(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	fake, client := newOAuthServer(t, 2*time.Second)
	dir := t.TempDir()
	writeNative(t, filepath.Join(dir, "codex.json"),
		Token{AccessToken: "stale", RefreshToken: "rt-1", AccountID: "acct", ExpiresAt: time.Now().Add(-time.Minute)}, 0o600)
	store := NewStore(client, StoreOptions{Dir: dir})

	refreshed := make(chan error, 1)
	go func() {
		_, _, err := store.Access(context.Background())
		refreshed <- err
	}()
	for deadline := time.Now().Add(5 * time.Second); fake.calls.Load() == 0; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the refresh never reached the token endpoint")
		}
	}

	began := time.Now()
	if !store.Authenticated() {
		t.Fatal("Authenticated = false during the refresh of a stored login")
	}
	if took := time.Since(began); took > 500*time.Millisecond {
		t.Fatalf("Authenticated took %v during a refresh", took)
	}
	if err := <-refreshed; err != nil {
		t.Fatalf("Access: %v", err)
	}
}

// A busy store answers the last known state, not "logged in"; a free one
// reads the files again.
func TestAuthenticatedWhileBusyAnswersTheLastKnownState(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	dir := t.TempDir()
	path := filepath.Join(dir, "codex.json")
	store := NewStore(nil, StoreOptions{Dir: dir})

	if store.Authenticated() {
		t.Fatal("Authenticated = true with no login")
	}
	store.mu.Lock()
	writeNative(t, path, Token{AccessToken: "a", RefreshToken: "r", ExpiresAt: time.Now().Add(time.Hour)}, 0o600)
	got := busyAuthenticated(t, store)
	store.mu.Unlock()
	if got {
		t.Fatal("a busy store with no known login answered true")
	}
	if !store.Authenticated() {
		t.Fatal("a free store did not read the login written meanwhile")
	}

	// Logging out leaves "not logged in" for a busy store to answer.
	if _, err := store.Remove(); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	store.mu.Lock()
	got = busyAuthenticated(t, store)
	store.mu.Unlock()
	if got {
		t.Fatal("a busy store answered true after the logout")
	}

	// A login saved through the store is known at once.
	if err := store.Save(&Token{AccessToken: "b", RefreshToken: "r2", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	store.mu.Lock()
	got = busyAuthenticated(t, store)
	store.mu.Unlock()
	if !got {
		t.Fatal("a busy store answered false after a login was saved")
	}
}

// busyAuthenticated calls Authenticated while the caller holds store.mu, on
// another goroutine, so a version that waits for the lock fails here instead
// of deadlocking the test. It answers false after the failure; the caller
// releases the lock.
func busyAuthenticated(t *testing.T, store *Store) bool {
	t.Helper()
	answered := make(chan bool, 1)
	go func() { answered <- store.Authenticated() }()
	select {
	case got := <-answered:
		return got
	case <-time.After(time.Second):
		t.Error("Authenticated waited for a busy store whose login state was known")
		return false
	}
}

// Before anything has loaded, a busy store is waited for once.
func TestAuthenticatedWaitsOnlyBeforeAnyState(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	dir := t.TempDir()
	writeNative(t, filepath.Join(dir, "codex.json"), Token{AccessToken: "a", RefreshToken: "r", ExpiresAt: time.Now().Add(time.Hour)}, 0o600)
	store := NewStore(nil, StoreOptions{Dir: dir})

	store.mu.Lock()
	answered := make(chan bool, 1)
	go func() { answered <- store.Authenticated() }()
	select {
	case got := <-answered:
		store.mu.Unlock()
		t.Fatalf("Authenticated answered %v with nothing known and the store busy", got)
	case <-time.After(100 * time.Millisecond):
	}
	store.mu.Unlock()
	select {
	case got := <-answered:
		if !got {
			t.Fatal("Authenticated = false with a stored login")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Authenticated did not answer once the store was free")
	}
}
