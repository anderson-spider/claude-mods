//go:build contract

package contract

import (
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

// The refresh token is single-use, so every proxy on one login (this release,
// or an older one that takes only the legacy lock) must exclude the others.
// The test process plays the other proxy with flock(2).

func lockFile(t *testing.T, path string) *os.File {
	t.Helper()
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	must(t, err)
	t.Cleanup(func() { _ = f.Close() })
	return f
}

func hold(t *testing.T, path string) (release func()) {
	t.Helper()
	f := lockFile(t, path)
	must(t, syscall.Flock(int(f.Fd()), syscall.LOCK_EX))
	var once sync.Once
	return func() { once.Do(func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }) }
}

// isHeld reports whether another descriptor holds the lock on path.
func isHeld(t *testing.T, path string) bool {
	t.Helper()
	f := lockFile(t, path)
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return true
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	_ = f.Close()
	return false
}

func waitUntil(t *testing.T, what string, within time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func asyncPost(e *env, model string) <-chan resp {
	out := make(chan resp, 1)
	go func() { out <- e.post("/v1/messages", claudeReq(model, true, nil)) }()
	return out
}

func expiredEnv(t *testing.T, tokenDelay time.Duration) *env {
	t.Helper()
	e := newEnv(t, opts{noStart: true, race: true})
	e.writeLogin(login{expires: time.Now().Add(-time.Hour), refresh: "refresh-1"})
	fresh := accessToken("new", time.Now().Add(time.Hour))
	slow := refreshing(fresh, "refresh-2", false)
	e.oauth.set(func(w http.ResponseWriter, r *http.Request, got rec) {
		time.Sleep(tokenDelay)
		slow(w, r, got)
	})
	e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	return e
}

func awaitResp(t *testing.T, ch <-chan resp) resp {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(20 * time.Second):
		t.Fatal("the request did not finish")
		return resp{}
	}
}

// While another process holds the lock beside the file, the binary holds the
// legacy lock and waits: legacy first, then the second, and no refresh yet.
func TestRefreshTakesTheLegacyLockThenTheOneBesideTheFile(t *testing.T) {
	e := expiredEnv(t, 0)
	// The auth directory resolves through /var -> /private/var on macOS; the
	// locks are keyed by file, so the paths below name the same files.
	dir, err := filepath.EvalSymlinks(e.authDir)
	must(t, err)
	release := hold(t, filepath.Join(dir, "codex.json.lock"))
	defer release()
	e.start()

	done := asyncPost(e, "gpt-6-astra")
	waitUntil(t, "the binary to hold the legacy lock codex.lock", 10*time.Second, func() bool {
		return isHeld(t, filepath.Join(dir, "codex.lock"))
	})
	time.Sleep(300 * time.Millisecond)
	if e.oauth.count() != 0 {
		t.Fatal("the token endpoint was called while the lock beside the file was held")
	}
	select {
	case <-done:
		t.Fatal("the request finished while the lock was held")
	default:
	}
	release()
	if r := awaitResp(t, done); r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	if e.oauth.count() != 1 {
		t.Fatalf("token endpoint calls = %d, want 1", e.oauth.count())
	}
	waitUntil(t, "the locks to be released", 5*time.Second, func() bool {
		return !isHeld(t, filepath.Join(dir, "codex.lock")) && !isHeld(t, filepath.Join(dir, "codex.json.lock"))
	})
}

// An older binary takes only codex.lock; this one must wait for it.
func TestRefreshWaitsForTheLegacyLockAlone(t *testing.T) {
	e := expiredEnv(t, 0)
	dir, err := filepath.EvalSymlinks(e.authDir)
	must(t, err)
	release := hold(t, filepath.Join(dir, "codex.lock"))
	defer release()
	e.start()

	done := asyncPost(e, "gpt-6-astra")
	time.Sleep(400 * time.Millisecond)
	if e.oauth.count() != 0 {
		t.Fatal("the token endpoint was called while the legacy lock was held")
	}
	select {
	case <-done:
		t.Fatal("the request finished while the legacy lock was held")
	default:
	}
	release()
	if r := awaitResp(t, done); r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	if e.oauth.count() != 1 {
		t.Fatalf("token endpoint calls = %d, want 1", e.oauth.count())
	}
}

// A request that waited for another process's refresh re-reads the file and
// uses its token instead of refreshing again.
func TestRefreshReReadsTheFileAfterTheLock(t *testing.T) {
	e := expiredEnv(t, 0)
	dir, err := filepath.EvalSymlinks(e.authDir)
	must(t, err)
	release := hold(t, filepath.Join(dir, "codex.json.lock"))
	defer release()
	e.start()

	done := asyncPost(e, "gpt-6-astra")
	waitUntil(t, "the binary to wait on the lock", 10*time.Second, func() bool {
		return isHeld(t, filepath.Join(dir, "codex.lock"))
	})
	// The other process refreshes and writes the login while holding the lock.
	other := accessToken("other-process", time.Now().Add(time.Hour))
	e.writeLogin(login{access: other, refresh: "refresh-by-other"})
	release()
	if r := awaitResp(t, done); r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	if e.oauth.count() != 0 {
		t.Fatalf("token endpoint calls = %d: the refreshed file was not re-read", e.oauth.count())
	}
	if got := e.cdx.last(t).Header.Get("Authorization"); got != "Bearer "+other {
		t.Fatal("Codex was not called with the other process's token")
	}
}

func TestConcurrentRequestsRefreshOnce(t *testing.T) {
	e := expiredEnv(t, 300*time.Millisecond)
	e.start()
	const n = 5
	var chans []<-chan resp
	for i := 0; i < n; i++ {
		chans = append(chans, asyncPost(e, "gpt-6-astra"))
	}
	for i, ch := range chans {
		if r := awaitResp(t, ch); r.Status != 200 {
			t.Fatalf("request %d: status = %d: %s", i, r.Status, r.Body)
		}
	}
	if e.oauth.count() != 1 {
		t.Fatalf("token endpoint calls = %d, want exactly 1", e.oauth.count())
	}
	if got := readLogin(t, filepath.Join(e.authDir, "codex.json"))["refresh_token"]; got != "refresh-2" {
		t.Fatalf("saved refresh_token = %v", got)
	}
}

func TestTwoProxiesOnOneAuthDirRefreshOnce(t *testing.T) {
	first := newEnv(t, opts{noStart: true, race: true})
	first.writeLogin(login{expires: time.Now().Add(-time.Hour), refresh: "refresh-1"})
	second := newEnv(t, opts{noStart: true, race: true, authDir: first.authDir, oauthFake: first.oauth})

	fresh := accessToken("new", time.Now().Add(time.Hour))
	slow := refreshing(fresh, "refresh-2", false)
	first.oauth.set(func(w http.ResponseWriter, r *http.Request, got rec) {
		time.Sleep(400 * time.Millisecond)
		slow(w, r, got)
	})
	for _, e := range []*env{first, second} {
		e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
		e.start()
	}
	a, b := asyncPost(first, "gpt-6-astra"), asyncPost(second, "gpt-6-astra")
	for i, ch := range []<-chan resp{a, b} {
		if r := awaitResp(t, ch); r.Status != 200 {
			t.Fatalf("proxy %d: status = %d: %s", i, r.Status, r.Body)
		}
	}
	if first.oauth.count() != 1 {
		t.Fatalf("token endpoint calls = %d, want exactly 1", first.oauth.count())
	}
	for i, e := range []*env{first, second} {
		if got := e.cdx.last(t).Header.Get("Authorization"); got != "Bearer "+fresh {
			t.Fatalf("proxy %d called Codex with %q", i, got)
		}
	}
}
