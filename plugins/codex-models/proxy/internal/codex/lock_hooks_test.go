package codex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// A cached credential is replaced by another writer under the lock: the
// new credential has the same size and the file keeps its old mtime (a coarse
// file system, or a writer that restores it), so the stamp does not move.
// Under the lock the store still reads the file again: it serves the new
// token and never spends the old refresh token, so the one refresh made is
// the other process's.
func TestRefreshRereadsWithAnUnchangedFileStamp(t *testing.T) {
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
	if _, err := store.Peek(); err != nil {
		t.Fatal(err)
	}
	releaseCurrent := holdLock(t, store.lockPath())
	{
		// The other process, holding the lock: it writes its refreshed
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
	}

	access, account, err := store.Access(context.Background())
	if err != nil {
		t.Fatalf("Access: %v", err)
	}
	if access != "access-new-1" || account != "acct" {
		t.Fatalf("Access = %q, %q; want the credential the other process wrote", access, account)
	}
	if n := calls.Load(); n != 0 {
		t.Fatalf("the token endpoint was called %d times; the old refresh token was spent", n)
	}
}
