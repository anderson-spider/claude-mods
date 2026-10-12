package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
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
type snapshot struct {
	data    []byte
	mode    os.FileMode
	modTime time.Time
	entries []string
}

func snap(t *testing.T, path string) snapshot {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	listing, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatalf("list %s: %v", filepath.Dir(path), err)
	}
	var entries []string
	for _, entry := range listing {
		entries = append(entries, entry.Name())
	}
	return snapshot{data: data, mode: info.Mode(), modTime: info.ModTime(), entries: entries}
}

func (s snapshot) assertUnchanged(t *testing.T, path, step string) {
	t.Helper()
	now := snap(t, path)
	if !bytes.Equal(now.data, s.data) {
		t.Fatalf("%s: the Codex CLI file was rewritten:\n%s", step, now.data)
	}
	if now.mode != s.mode || !now.modTime.Equal(s.modTime) {
		t.Fatalf("%s: the Codex CLI file was touched (mode %v -> %v, mtime %v -> %v)",
			step, s.mode, now.mode, s.modTime, now.modTime)
	}
	if strings.Join(now.entries, ",") != strings.Join(s.entries, ",") {
		t.Fatalf("%s: the Codex CLI directory changed: %v -> %v", step, s.entries, now.entries)
	}
}

// cliHome points CODEX_HOME at a fresh directory and writes a CLI login there.
func cliHome(t *testing.T, expiresIn time.Duration) (home, path string) {
	t.Helper()
	home = filepath.Join(t.TempDir(), ".codex")
	path = writeCodexCLIAuth(t, home, accessToken(expiresIn, "acct_cli", "plus"), "rt-cli")
	t.Setenv("CODEX_HOME", home)
	return home, path
}

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

func TestCandidateOrder(t *testing.T) {
	home, _ := cliHome(t, time.Hour)
	dir := t.TempDir()
	own := filepath.Join(dir, "codex.json")
	cli := filepath.Join(home, "auth.json")

	for _, tc := range []struct {
		name    string
		options StoreOptions
		want    []string
	}{
		{"own file only by default", StoreOptions{Dir: dir}, []string{own}},
		{"own file, then the CLI's", StoreOptions{Dir: dir, UseCodexCLI: true}, []string{own, cli}},
		{"auth_file alone", StoreOptions{Dir: dir, ExplicitPath: "/elsewhere/creds.json", UseCodexCLI: true},
			[]string{"/elsewhere/creds.json"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := NewStore(nil, tc.options).Sources()
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Fatalf("Sources() = %v, want %v", got, tc.want)
			}
		})
	}
}

// The CLI's login is borrowed as is: Access within the refresh lead, a Save,
// a refresh of the proxy's own token and a logout all leave it byte for byte.
func TestCodexCLIFileIsNeverWrittenOrRemoved(t *testing.T) {
	// Inside the refresh lead: an own file would be refreshed here.
	_, cli := cliHome(t, 2*time.Minute)
	before := snap(t, cli)
	time.Sleep(10 * time.Millisecond)

	fake, client := newOAuthServer(t, 0)
	dir := t.TempDir()
	store := NewStore(client, StoreOptions{Dir: dir, UseCodexCLI: true})

	access, account, err := store.Access(context.Background())
	if err != nil {
		t.Fatalf("Access: %v", err)
	}
	if access == "" || account != "acct_cli" {
		t.Fatalf("Access = %q/%q, want the CLI's token", access, account)
	}
	if n := fake.calls.Load(); n != 0 {
		t.Fatalf("the CLI's token was refreshed (%d calls)", n)
	}
	before.assertUnchanged(t, cli, "Access")

	// login: the proxy's own file, never the CLI's.
	if err := store.Save(&Token{AccessToken: "own", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(-time.Minute)}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	before.assertUnchanged(t, cli, "Save")

	// The proxy's own expired token is refreshed into its own file.
	access, _, err = store.Access(context.Background())
	if err != nil {
		t.Fatalf("Access after Save: %v", err)
	}
	if access != "access-from-rt-1" {
		t.Fatalf("access = %q, want the refreshed own token", access)
	}
	before.assertUnchanged(t, cli, "refresh")

	removed, err := store.Remove()
	if err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if removed != filepath.Join(dir, "codex.json") {
		t.Fatalf("Remove removed %s, want the proxy's own file", removed)
	}
	if _, err := os.Stat(removed); !os.IsNotExist(err) {
		t.Fatalf("the proxy's own file is still there: %v", err)
	}
	before.assertUnchanged(t, cli, "Remove")

	// Nothing of the proxy's own is left: logout does not move on to the CLI's.
	if _, err := store.Remove(); !os.IsNotExist(err) {
		t.Fatalf("a second Remove = %v, want not-exist", err)
	}
	before.assertUnchanged(t, cli, "second Remove")
	if n := fake.calls.Load(); n != 1 {
		t.Fatalf("refresh calls = %d, want only the proxy's own one", n)
	}
}

func TestExpiredCodexCLILoginFailsWithoutRefreshing(t *testing.T) {
	_, cli := cliHome(t, -time.Hour)
	before := snap(t, cli)
	fake, client := newOAuthServer(t, 0)

	store := NewStore(client, StoreOptions{Dir: t.TempDir(), UseCodexCLI: true})
	_, _, err := store.Access(context.Background())
	if !errors.Is(err, ErrCodexCLILoginExpired) {
		t.Fatalf("Access error = %v, want ErrCodexCLILoginExpired", err)
	}
	for _, hint := range []string{"`codex login`", "`ccmproxy login codex`", cli} {
		if !strings.Contains(err.Error(), hint) {
			t.Fatalf("error %q does not mention %s", err, hint)
		}
	}
	if n := fake.calls.Load(); n != 0 {
		t.Fatalf("an expired CLI login reached the token endpoint (%d calls)", n)
	}
	before.assertUnchanged(t, cli, "Access")
}

// caseInsensitive reports whether dir's volume ignores case.
func caseInsensitive(dir string) bool {
	upper := filepath.Join(filepath.Dir(dir), strings.ToUpper(filepath.Base(dir)))
	if upper == dir {
		return false
	}
	a, errA := os.Stat(dir)
	b, errB := os.Stat(upper)
	return errA == nil && errB == nil && os.SameFile(a, b)
}

func TestAuthFileNamingTheCodexCLIFileIsRefused(t *testing.T) {
	home, cli := cliHome(t, -time.Hour)
	links := t.TempDir()

	symlink := filepath.Join(links, "link.json")
	if err := os.Symlink(cli, symlink); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	dirLink := filepath.Join(links, "codex-dir")
	if err := os.Symlink(home, dirLink); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	// Joined by hand: filepath.Join would clean the `..` away.
	dotdot := home + string(filepath.Separator) + ".." + string(filepath.Separator) + ".codex" +
		string(filepath.Separator) + "auth.json"
	cases := map[string]string{
		"direct":      cli,
		"symlink":     symlink,
		"dotdot":      dotdot,
		"dir symlink": filepath.Join(dirLink, "auth.json"),
	}
	if rel, err := filepath.Rel(mustGetwd(t), cli); err == nil {
		cases["relative"] = rel
	}
	if runtime.GOOS == "darwin" && caseInsensitive(home) {
		cases["case"] = filepath.Join(filepath.Dir(home), strings.ToUpper(filepath.Base(home)), "AUTH.JSON")
	}

	for name, path := range cases {
		t.Run(name, func(t *testing.T) {
			before := snap(t, cli)
			fake, client := newOAuthServer(t, 0)
			store := NewStore(client, StoreOptions{Dir: t.TempDir(), ExplicitPath: path})

			if err := store.Check(); !errors.Is(err, ErrAuthFileIsCodexCLI) {
				t.Fatalf("Check() = %v, want ErrAuthFileIsCodexCLI", err)
			}
			if _, err := store.Peek(); !errors.Is(err, ErrAuthFileIsCodexCLI) {
				t.Fatalf("Peek() = %v, want ErrAuthFileIsCodexCLI", err)
			}
			if _, _, err := store.Access(context.Background()); !errors.Is(err, ErrAuthFileIsCodexCLI) {
				t.Fatalf("Access() = %v, want ErrAuthFileIsCodexCLI", err)
			}
			if err := store.Save(&Token{AccessToken: "x", RefreshToken: "y"}); !errors.Is(err, ErrAuthFileIsCodexCLI) {
				t.Fatalf("Save() = %v, want ErrAuthFileIsCodexCLI", err)
			}
			if _, err := store.Remove(); !errors.Is(err, ErrAuthFileIsCodexCLI) {
				t.Fatalf("Remove() = %v, want ErrAuthFileIsCodexCLI", err)
			}
			if n := fake.calls.Load(); n != 0 {
				t.Fatalf("token endpoint called %d times", n)
			}
			before.assertUnchanged(t, cli, name)
			if _, err := os.Lstat(symlink); err != nil {
				t.Fatalf("the symlink was removed: %v", err)
			}
		})
	}
}

// Before the Codex CLI has signed in its file does not exist; an auth_file
// naming it (or a link to it) is refused all the same.
func TestAuthFileNamingAMissingCodexCLIFileIsRefused(t *testing.T) {
	home := filepath.Join(t.TempDir(), ".codex")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Setenv("CODEX_HOME", home)
	dangling := filepath.Join(t.TempDir(), "link.json")
	if err := os.Symlink(filepath.Join(home, "auth.json"), dangling); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	for _, path := range []string{filepath.Join(home, "auth.json"), dangling} {
		store := NewStore(nil, StoreOptions{Dir: t.TempDir(), ExplicitPath: path})
		if err := store.Save(&Token{AccessToken: "x"}); !errors.Is(err, ErrAuthFileIsCodexCLI) {
			t.Fatalf("Save to %s = %v, want ErrAuthFileIsCodexCLI", path, err)
		}
		if _, err := os.Stat(filepath.Join(home, "auth.json")); !os.IsNotExist(err) {
			t.Fatalf("the Codex CLI file was created through %s", path)
		}
	}
}

// The proxy's own file turned into a link to the CLI's is treated as the CLI's.
func TestOwnFileLinkedToTheCodexCLIFileIsReadOnly(t *testing.T) {
	_, cli := cliHome(t, -time.Hour)
	dir := t.TempDir()
	if err := os.Symlink(cli, filepath.Join(dir, "codex.json")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	before := snap(t, cli)
	fake, client := newOAuthServer(t, 0)

	store := NewStore(client, StoreOptions{Dir: dir})
	if _, _, err := store.Access(context.Background()); !errors.Is(err, ErrCodexCLILoginExpired) {
		t.Fatalf("Access = %v, want ErrCodexCLILoginExpired", err)
	}
	if err := store.Save(&Token{AccessToken: "x"}); err == nil {
		t.Fatal("Save wrote through a link to the Codex CLI file")
	}
	if _, err := store.Remove(); err == nil {
		t.Fatal("Remove accepted a link to the Codex CLI file")
	}
	if n := fake.calls.Load(); n != 0 {
		t.Fatalf("token endpoint called %d times", n)
	}
	before.assertUnchanged(t, cli, "linked own file")
}

func TestAtomicWriteTightensAnExistingFile(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
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
	t.Setenv("CODEX_HOME", t.TempDir())
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
	t.Setenv("CODEX_HOME", t.TempDir())
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
	t.Setenv("CODEX_HOME", t.TempDir())
	fake, client := newOAuthServer(t, 0)
	dir := t.TempDir()
	path := filepath.Join(dir, "codex.json")
	writeNative(t, path, Token{AccessToken: "stale", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(-time.Minute)}, 0o600)

	// Another instance holds the lock, mid-refresh.
	held, err := os.OpenFile(filepath.Join(dir, lockFileName), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatalf("open lock: %v", err)
	}
	defer held.Close()
	if err := syscall.Flock(int(held.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatalf("flock: %v", err)
	}

	waiting := make(chan struct{})
	var once sync.Once
	lockBusy = func() { once.Do(func() { close(waiting) }) }
	t.Cleanup(func() { lockBusy = nil })

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
	case <-waiting:
	case r := <-done:
		t.Fatalf("Access returned without waiting for the lock: %+v", r)
	case <-time.After(5 * time.Second):
		t.Fatal("Access never reached the lock")
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
