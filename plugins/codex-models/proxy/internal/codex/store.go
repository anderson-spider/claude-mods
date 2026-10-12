package codex

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// nativeFileName is this proxy's own credential file in auth_dir.
const nativeFileName = "codex.json"

// StoreOptions configures where credentials are looked for.
type StoreOptions struct {
	// Dir is where this proxy keeps its own credential file and its lock.
	Dir string
	// ExplicitPath, when set, is the only file consulted, in whichever
	// layout it turns out to be. It must not be the Codex CLI's file.
	ExplicitPath string
	// UseCodexCLI enables reading the Codex CLI's ~/.codex/auth.json,
	// read-only, when this proxy has no credentials of its own.
	UseCodexCLI bool
}

// source is one candidate credential file.
type source struct {
	path   string
	format format
	// readOnly marks the Codex CLI's file (by whatever path it was reached):
	// it is used while its access token is valid and never refreshed,
	// written or removed.
	readOnly bool
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
// Credentials are looked for in order: an explicitly configured file, or else
// this proxy's own file, then (when enabled) the Codex CLI's
// ~/.codex/auth.json. Only this proxy's own files are refreshed and written;
// the Codex CLI's login is borrowed read-only.
type Store struct {
	client  *Client
	options StoreOptions

	// mu guards everything below and is held across a whole refresh, so one
	// process refreshes once; the file locks do the same across processes.
	mu     sync.Mutex
	token  *Token
	active source
	// stamp is the active file's stamp when it was read, so an external
	// update (the Codex CLI or another proxy refreshing) is noticed instead
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

func (s *Store) explicitPath() string { return strings.TrimSpace(s.options.ExplicitPath) }

// Check refuses a configuration whose auth_file resolves to the Codex CLI's
// credential file (directly, through a symlink, `..` or a different case on
// a case-insensitive volume). Every read, write and removal runs it; call it
// at start to fail early.
//
// It also refuses an auth_dir that is the Codex CLI's directory or inside it,
// and a credential file (auth_file, or auth_dir's codex.json) that resolves
// there through its own links (a dangling one included), so the proxy's
// file, its lock and the 0700 it sets never land there and a refresh token
// is never spent on a file the proxy may not write.
func (s *Store) Check() error {
	explicit := s.explicitPath()
	if explicit != "" {
		if cli := CodexCLIAuthPath(); cli != "" && sameFile(explicit, cli) {
			return fmt.Errorf("%w (%s is %s)", ErrAuthFileIsCodexCLI, explicit, cli)
		}
		if insideCodexHome(explicit) {
			return insideHomeError("auth_file", explicit)
		}
	}
	dir := strings.TrimSpace(s.options.Dir)
	if dir == "" {
		return nil
	}
	if insideCodexHome(dir) {
		return insideHomeError("auth_dir", dir)
	}
	if native := filepath.Join(dir, nativeFileName); explicit == "" && insideCodexHome(native) {
		return insideHomeError("auth_dir's "+nativeFileName, native)
	}
	return nil
}

// insideHomeError names what lands in CODEX_HOME, with both paths resolved
// the same way so they read alike.
func insideHomeError(what, path string) error {
	home := resolvePath(CodexCLIHome(), 0)
	resolved := resolvePath(path, 0)
	switch {
	case sameFile(resolved, home):
		return fmt.Errorf("%w (%s is the Codex CLI's directory, %s)", ErrInsideCodexHome, what, home)
	case resolved == filepath.Clean(path):
		return fmt.Errorf("%w (%s %s is in the Codex CLI's directory, %s)", ErrInsideCodexHome, what, path, home)
	default:
		return fmt.Errorf("%w (%s %s leads to %s, in the Codex CLI's directory, %s)", ErrInsideCodexHome, what, path, resolved, home)
	}
}

// NativePath reports this proxy's own credential file.
func (s *Store) NativePath() string {
	if explicit := s.explicitPath(); explicit != "" {
		return explicit
	}
	return filepath.Join(s.options.Dir, nativeFileName)
}

// Path reports the file credentials were loaded from, falling back to the file
// a fresh login would write.
func (s *Store) Path() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active.path != "" {
		return s.active.path
	}
	return s.NativePath()
}

// Sources lists the candidate files in the order they are consulted.
func (s *Store) Sources() []string {
	candidates := s.candidates()
	paths := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		paths = append(paths, candidate.path)
	}
	return paths
}

// candidates are the files to try, in order: an explicitly named one alone
// (its layout read from its contents), else this proxy's own file and, when
// enabled, the Codex CLI's.
func (s *Store) candidates() []source {
	if explicit := s.explicitPath(); explicit != "" {
		return []source{{path: explicit, format: formatUnknown}}
	}
	candidates := []source{{path: filepath.Join(s.options.Dir, nativeFileName), format: formatNative}}
	if s.options.UseCodexCLI {
		if cli := CodexCLIAuthPath(); cli != "" {
			candidates = append(candidates, source{path: cli, format: formatCodexCLI, readOnly: true})
		}
	}
	return candidates
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
	target := source{path: s.NativePath(), format: formatNative}
	// An explicitly configured file keeps its layout.
	if s.explicitPath() != "" {
		target.format = detectFormatOfFile(target.path)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := s.lock(context.Background())
	if err != nil {
		return err
	}
	defer unlock()
	return s.writeLocked(token, target)
}

// Remove deletes this proxy's own credential file and reports its path. It
// never removes the Codex CLI's file; a missing file is an os.ErrNotExist.
func (s *Store) Remove() (string, error) {
	if err := s.Check(); err != nil {
		return "", err
	}
	path := s.NativePath()
	if refersToCodexCLI(path) {
		return path, fmt.Errorf("codex: %s is the Codex CLI's login file; this proxy never removes it", path)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := s.lock(context.Background())
	if err != nil {
		return path, err
	}
	defer unlock()
	if err := os.Remove(path); err != nil {
		return path, err
	}
	s.forgetLocked()
	return path, nil
}

// forgetLocked drops the cached credential, the active file and the latch.
func (s *Store) forgetLocked() {
	s.token, s.active, s.stamp, s.rejected = nil, source{}, fileStamp{}, nil
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
// otherwise reads the first candidate that holds one. Its outcome is the
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
	// A file changed underneath (the Codex CLI or another proxy refreshing)
	// invalidates the cache: its refresh token may have been rotated.
	if s.token != nil && !s.staleLocked() {
		return s.token, nil
	}

	var lastErr error
	for _, candidate := range s.candidates() {
		token, used, err := s.read(candidate)
		switch {
		case err != nil:
			lastErr = err
			continue
		case token == nil:
			continue
		}
		if s.active.path != used.path {
			if used.readOnly {
				logx.Infof("codex: using credentials from %s (read-only, never refreshed)", used.path)
			} else {
				logx.Infof("codex: using credentials from %s", used.path)
			}
		}
		s.token, s.active, s.stamp = token, used, stampOf(used.path)
		return token, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, ErrNotAuthenticated
}

// read decodes one candidate. It returns no token and no error for a file
// that is missing or holds neither an access nor a refresh token, and the
// source as it was read: a candidate that leads to the Codex CLI's file
// (this proxy's own file may be a link to it) is read in that file's layout
// and borrowed read-only.
func (s *Store) read(candidate source) (*Token, source, error) {
	data, err := os.ReadFile(candidate.path)
	if os.IsNotExist(err) {
		return nil, candidate, nil
	}
	if err != nil {
		return nil, candidate, fmt.Errorf("codex: read %s: %w", candidate.path, err)
	}
	candidate.readOnly = candidate.readOnly || refersToCodexCLI(candidate.path)
	if candidate.format == formatUnknown || candidate.readOnly {
		candidate.format = detectFormat(data)
	}
	token, err := decodeCredentials(data, candidate.format)
	if err != nil {
		return nil, candidate, err
	}
	if token.AccessToken == "" && token.RefreshToken == "" {
		return nil, candidate, nil
	}
	return token, candidate, nil
}

// staleLocked reports whether the active file changed (or went away) since
// it was read.
func (s *Store) staleLocked() bool {
	if s.active.path == "" {
		return true
	}
	current := stampOf(s.active.path)
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
