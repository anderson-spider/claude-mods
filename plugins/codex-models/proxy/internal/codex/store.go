package codex

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// nativeFileName is this proxy's own credential file in auth_dir.
const nativeFileName = "codex.json"

// StoreOptions names the directory of the proxy's native credentials.
type StoreOptions struct {
	Dir string
}

// fileStamp is a file's size and modification time, enough to notice that
// someone rewrote it.
type fileStamp struct {
	size    int64
	modTime time.Time
}

func stampOf(path string) fileStamp {
	info, err := os.Stat(path)
	if err != nil {
		return fileStamp{}
	}
	return fileStamp{size: info.Size(), modTime: info.ModTime()}
}

func (f fileStamp) missing() bool { return f.size == 0 && f.modTime.IsZero() }

// Store finds, caches and refreshes Codex credentials.
//
// The only credential file is codex.json under auth_dir. Directory aliases
// share the canonical file lock; credential-file symlinks are refused.
type Store struct {
	client  *Client
	options StoreOptions

	// mu guards everything below and is held across a whole refresh, so one
	// process refreshes once; the file lock do the same across processes.
	mu     sync.Mutex
	token  *Token
	active string
	// stamp is the active file's stamp when it was read, so an external
	// update (another proxy refreshing) is noticed instead
	// of served from a stale cache.
	stamp fileStamp
	// rejected is the latch on a credential whose refresh the token endpoint
	// refused: it is not sent again until the file changes (refresh.go).
	rejected *rejection

	// loginHeld is whether the last load, refresh, login or logout left a
	// usable login, and loginKnown whether any has run. They are read
	// without mu, so a status never waits behind a token refresh
	// (Authenticated).
	loginHeld  atomic.Bool
	loginKnown atomic.Bool
}

// NewStore builds a store from the given options.
func NewStore(client *Client, options StoreOptions) *Store {
	if client == nil {
		client = NewClient(nil)
	}
	return &Store{client: client, options: options}
}

// Check refuses credential symlinks, dangling links included, before reads,
// refreshes, saves and removals. Directory aliases remain allowed.
func (s *Store) Check() error { return refuseCredentialLink(s.NativePath()) }

// NativePath reports this proxy's own credential file.
func (s *Store) NativePath() string {
	return filepath.Join(s.options.Dir, nativeFileName)
}

// Path reports the file credentials were loaded from, falling back to the file
// a fresh login would write.
func (s *Store) Path() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != "" {
		return s.active
	}
	return s.NativePath()
}

// Save writes token to this proxy's own credential file and installs it as the
// active credential.
func (s *Store) Save(token *Token) error {
	if token == nil {
		return fmt.Errorf("codex: nothing to save")
	}
	if err := s.Check(); err != nil {
		return err
	}
	target := s.NativePath()

	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := s.lock(context.Background())
	if err != nil {
		return err
	}
	defer unlock()
	return s.writeLocked(token, target)
}

// Remove deletes the native credential file and reports its path. A missing
// file is an os.ErrNotExist; a symlink is refused before removal.
func (s *Store) Remove() (string, error) {
	if err := s.Check(); err != nil {
		return "", err
	}
	path := s.NativePath()

	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := s.lock(context.Background())
	if err != nil {
		return path, err
	}
	defer unlock()
	if err := s.Check(); err != nil {
		return path, err
	}
	if err := os.Remove(writeTarget(path)); err != nil {
		return path, err
	}
	s.forgetLocked()
	return path, nil
}

// forgetLocked drops the cached credential, the active file and the latch.
func (s *Store) forgetLocked() {
	s.token, s.active, s.stamp, s.rejected = nil, "", fileStamp{}, nil
	s.noteLogin(false)
}

// noteLogin records whether a usable login is held, for Authenticated.
func (s *Store) noteLogin(held bool) {
	s.loginHeld.Store(held)
	s.loginKnown.Store(true)
}

// Peek returns the cached or on-disk token without refreshing it.
func (s *Store) Peek() (*Token, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

// Authenticated reports whether credentials are available, without waiting
// behind another caller: a token refresh holds the store for the token
// endpoint's whole round trip. A free store is read as Peek reads it, so a
// login written by another process shows at once. A busy one answers what the
// last load, refresh, login or logout found, which is not "logged in" by
// default; it waits only when none has run yet (Access loads before it
// refreshes, so a refresh always leaves a value).
func (s *Store) Authenticated() bool {
	if s.mu.TryLock() {
		defer s.mu.Unlock()
		_, err := s.loadLocked()
		return err == nil
	}
	if s.loginKnown.Load() {
		return s.loginHeld.Load()
	}
	_, err := s.Peek()
	return err == nil
}

// loadLocked returns the cached credential while its file is unchanged, and
// otherwise reads the native credential file. Its outcome is the
// login state Authenticated answers while the store is busy.
func (s *Store) loadLocked() (*Token, error) {
	token, err := s.findLocked()
	s.noteLogin(err == nil)
	return token, err
}

// findLocked is loadLocked without the note.
func (s *Store) findLocked() (*Token, error) {
	if err := s.Check(); err != nil {
		return nil, err
	}
	// A file changed underneath (another proxy refreshing)
	// invalidates the cache: its refresh token may have been rotated.
	if s.token != nil && !s.staleLocked() {
		return s.token, nil
	}

	path := s.NativePath()
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotAuthenticated
		}
		return nil, fmt.Errorf("codex: read %s: %w", path, err)
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if os.IsNotExist(err) {
		return nil, ErrNotAuthenticated
	}
	if err != nil {
		return nil, fmt.Errorf("codex: read %s: %w", path, err)
	}
	token, err := decodeNative(data)
	if err != nil {
		return nil, err
	}
	if token.AccessToken == "" && token.RefreshToken == "" {
		return nil, ErrNotAuthenticated
	}
	if s.active != path {
		logx.Infof("codex: using credentials from %s", path)
	}
	s.token, s.active, s.stamp = token, path, stampOf(path)
	return token, nil
}

// staleLocked reports whether the active file changed (or went away) since
// it was read.
func (s *Store) staleLocked() bool {
	if s.active == "" {
		return true
	}
	current := stampOf(s.active)
	return current.missing() || current != s.stamp
}

// rejection identifies a refused credential by its file, the file's stamp and
// a hash of the refresh token (never the token itself), with the error to
// answer while it stands.
type rejection struct {
	path    string
	stamp   fileStamp
	refresh [sha256.Size]byte
	err     error
}
