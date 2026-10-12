package codex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jclab-joseph/claude-code-model-proxy/internal/logx"
	"github.com/tidwall/gjson"
)

// ErrNotAuthenticated is returned when no Codex credentials can be found.
var ErrNotAuthenticated = errors.New("codex: not authenticated, run `ccmproxy login codex`")

// ErrLoginExpired is returned when the token endpoint refuses to refresh this
// proxy's own login (expired, revoked, or its refresh token already spent):
// only signing in again helps.
var ErrLoginExpired = errors.New("codex: the proxy's Codex login has expired or was revoked; " +
	"run `ccmproxy login codex` to sign in again")

// ErrCodexCLILoginExpired is returned when the borrowed Codex CLI login has an
// expired access token. The proxy never refreshes that login: OpenAI rotates
// refresh tokens, so a refresh here would sign the Codex CLI (and the crew's
// `codex exec`) out.
var ErrCodexCLILoginExpired = errors.New("codex: the Codex CLI login has expired and this proxy never refreshes it; " +
	"run `codex login` to renew it, or `ccmproxy login codex` to give the proxy its own login")

// ErrAuthFileIsCodexCLI is returned when codex.auth_file names the Codex CLI's
// own credential file, which this proxy only ever reads.
var ErrAuthFileIsCodexCLI = errors.New("codex: auth_file is the Codex CLI's login file, which this proxy never writes; " +
	"leave auth_file empty (and set use_codex_cli_auth to borrow that login read-only) or point it at another file")

// refreshLead refreshes an access token this far before it expires.
const refreshLead = 5 * time.Minute

// nativeFileName is this proxy's own credential file.
const nativeFileName = "codex.json"

// lockFileName serialises refreshes and logins across proxy processes.
const lockFileName = "codex.lock"

// lockWait bounds the wait for another process's refresh; it outlasts the
// OAuth client's own 30 s timeout.
const lockWait = 45 * time.Second

// lockPoll is how often a held lock is tried again.
const lockPoll = 25 * time.Millisecond

// lockBusy, when set (by tests), runs once each time lock finds the lock held.
var lockBusy func()

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

// Store finds, caches and refreshes Codex credentials.
//
// Credentials are looked for in order: an explicitly configured file, or else
// this proxy's own file, then (when enabled) the Codex CLI's
// ~/.codex/auth.json. Only this proxy's own files are refreshed and written;
// the Codex CLI's login is borrowed read-only.
type Store struct {
	client  *Client
	options StoreOptions

	mu     sync.Mutex
	token  *Token
	active source
	// stamp is the size and modification time of the active file when it was
	// read, so an external update (the Codex CLI or another proxy refreshing)
	// is noticed instead of being served from a stale cache.
	stamp fileStamp
}

type fileStamp struct {
	size    int64
	modTime time.Time
}

// NewStore builds a store from the given options.
func NewStore(client *Client, options StoreOptions) *Store {
	if client == nil {
		client = NewClient(nil)
	}
	return &Store{client: client, options: options}
}

// Check refuses a configuration whose auth_file resolves to the Codex CLI's
// credential file (directly, through a symlink, `..` or a different case on
// a case-insensitive volume). Every read, write and removal runs it; call it
// at start to fail early.
func (s *Store) Check() error {
	path := strings.TrimSpace(s.options.ExplicitPath)
	if path == "" {
		return nil
	}
	if cli := CodexCLIAuthPath(); cli != "" && sameFile(path, cli) {
		return fmt.Errorf("%w (%s is %s)", ErrAuthFileIsCodexCLI, path, cli)
	}
	return nil
}

// NativePath reports this proxy's own credential file.
func (s *Store) NativePath() string {
	if path := strings.TrimSpace(s.options.ExplicitPath); path != "" {
		return path
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
	sources := s.candidates()
	paths := make([]string, 0, len(sources))
	for _, candidate := range sources {
		paths = append(paths, candidate.path)
	}
	return paths
}

func (s *Store) candidates() []source {
	if path := strings.TrimSpace(s.options.ExplicitPath); path != "" {
		// The layout of an explicitly named file is detected from its
		// contents rather than assumed.
		return []source{{path: path, format: formatUnknown}}
	}

	candidates := []source{{path: filepath.Join(s.options.Dir, nativeFileName), format: formatNative}}
	if s.options.UseCodexCLI {
		if path := CodexCLIAuthPath(); path != "" {
			candidates = append(candidates, source{path: path, format: formatCodexCLI, readOnly: true})
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
	path := s.NativePath()
	kind := formatNative
	// Writing to an explicitly configured file keeps that file's layout.
	if strings.TrimSpace(s.options.ExplicitPath) != "" {
		kind = detectFormatOfFile(path)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := s.lock(context.Background())
	if err != nil {
		return err
	}
	defer unlock()
	return s.writeLocked(token, source{path: path, format: kind})
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
	s.token, s.active, s.stamp = nil, source{}, fileStamp{}
	return path, nil
}

// Peek returns the cached or on-disk token without refreshing it.
func (s *Store) Peek() (*Token, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

// Authenticated reports whether credentials are available.
func (s *Store) Authenticated() bool {
	_, err := s.Peek()
	return err == nil
}

func (s *Store) loadLocked() (*Token, error) {
	if err := s.Check(); err != nil {
		return nil, err
	}
	// A file changed underneath us (the Codex CLI or another proxy
	// refreshing) invalidates the cache: its refresh token may be rotated.
	if s.token != nil && !s.staleLocked() {
		return s.token, nil
	}

	var lastErr error
	for _, candidate := range s.candidates() {
		data, err := os.ReadFile(candidate.path)
		if err != nil {
			if !os.IsNotExist(err) {
				lastErr = fmt.Errorf("codex: read %s: %w", candidate.path, err)
			}
			continue
		}

		// The proxy's own file may itself be a link to the CLI's; it is then
		// read in the CLI's layout and borrowed the same way.
		readOnly := candidate.readOnly || refersToCodexCLI(candidate.path)
		kind := candidate.format
		if kind == formatUnknown || readOnly {
			kind = detectFormat(data)
		}
		token, err := decodeCredentials(data, kind)
		if err != nil {
			lastErr = err
			continue
		}
		if token.AccessToken == "" && token.RefreshToken == "" {
			continue
		}

		if s.active.path != candidate.path {
			if readOnly {
				logx.Infof("codex: using credentials from %s (read-only, never refreshed)", candidate.path)
			} else {
				logx.Infof("codex: using credentials from %s", candidate.path)
			}
		}
		s.token = token
		s.active = source{path: candidate.path, format: kind, readOnly: readOnly}
		s.stamp = stampOf(candidate.path)
		return token, nil
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return nil, ErrNotAuthenticated
}

// staleLocked reports whether the active file changed since it was read.
func (s *Store) staleLocked() bool {
	if s.active.path == "" {
		return true
	}
	current := stampOf(s.active.path)
	if current.size == 0 && current.modTime.IsZero() {
		// The file went away; fall back to rediscovery.
		return true
	}
	return current != s.stamp
}

// Access returns a usable access token together with the account id,
// refreshing this proxy's own credential when it is close to expiry.
func (s *Store) Access(ctx context.Context) (accessToken, accountID string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	token, err := s.loadLocked()
	if err != nil {
		return "", "", err
	}
	if s.active.readOnly {
		return s.borrowedLocked(token)
	}
	if !token.Expired(refreshLead) {
		return token.AccessToken, token.AccountID, nil
	}

	// Another proxy process may be refreshing the same file: hold the lock,
	// then re-read, so only one of them spends the refresh token.
	unlock, err := s.lock(ctx)
	if err != nil {
		if !token.Expired(0) {
			logx.Warnf("codex: %v; using the current token", err)
			return token.AccessToken, token.AccountID, nil
		}
		return "", "", err
	}
	defer unlock()

	s.token = nil
	if token, err = s.loadLocked(); err != nil {
		return "", "", err
	}
	if s.active.readOnly {
		return s.borrowedLocked(token)
	}
	if !token.Expired(refreshLead) {
		return token.AccessToken, token.AccountID, nil
	}
	if token.RefreshToken == "" {
		if !token.Expired(0) {
			return token.AccessToken, token.AccountID, nil
		}
		return "", "", ErrNotAuthenticated
	}

	logx.Infof("codex: refreshing access token (expires %s)", expiryLabel(token))
	refreshed, err := s.client.Refresh(context.WithoutCancel(ctx), token.RefreshToken)
	if err != nil {
		// A still-valid token is worth trying even if the refresh failed;
		// only a genuinely expired one is a hard error.
		if !token.Expired(0) {
			logx.Warnf("codex: token refresh failed, using the current token: %v", err)
			return token.AccessToken, token.AccountID, nil
		}
		return "", "", err
	}

	// A refresh response repeats little about the account; carry the rest
	// over from the token being replaced.
	if refreshed.AccountID == "" {
		refreshed.AccountID = token.AccountID
	}
	if refreshed.Email == "" {
		refreshed.Email = token.Email
	}
	if refreshed.PlanType == "" {
		refreshed.PlanType = token.PlanType
	}
	if refreshed.IDToken == "" {
		refreshed.IDToken = token.IDToken
	}

	if err := s.writeLocked(refreshed, s.active); err != nil {
		logx.Warnf("codex: could not persist the refreshed token: %v", err)
		s.token = refreshed
	}
	return refreshed.AccessToken, refreshed.AccountID, nil
}

// borrowedLocked serves the Codex CLI's login while its access token is valid.
func (s *Store) borrowedLocked(token *Token) (string, string, error) {
	if token.Expired(0) {
		return "", "", fmt.Errorf("%w (%s)", ErrCodexCLILoginExpired, s.active.path)
	}
	return token.AccessToken, token.AccountID, nil
}

// writeLocked persists token to the given file, preserving any fields of that
// file this proxy does not own. The caller holds the file lock.
func (s *Store) writeLocked(token *Token, target source) error {
	if target.path == "" {
		return fmt.Errorf("codex: no credential file to write to")
	}
	if target.readOnly || refersToCodexCLI(target.path) {
		return fmt.Errorf("codex: %s is the Codex CLI's login file; this proxy never writes it", target.path)
	}
	if token.LastRefresh.IsZero() {
		token.LastRefresh = time.Now()
	}

	var previous []byte
	if target.format == formatCodexCLI {
		previous, _ = os.ReadFile(target.path)
	}
	data, err := encodeCredentials(token, target.format, previous)
	if err != nil {
		return err
	}
	if err := s.writeFileAtomic(target.path, data); err != nil {
		return err
	}

	s.token = token
	s.active = target
	s.stamp = stampOf(target.path)
	return nil
}

// writeFileAtomic replaces path with data at mode 0600: a temporary file in the
// same directory, synced, then renamed over it, so a reader never sees half a
// file and an existing looser mode does not survive. A symlink is written
// through to its target.
func (s *Store) writeFileAtomic(path string, data []byte) error {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	dir := filepath.Dir(path)
	if err := s.ensureDir(dir); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("codex: write %s: %w", path, err)
	}
	name := tmp.Name()
	fail := func(err error) error {
		_ = tmp.Close()
		_ = os.Remove(name)
		return fmt.Errorf("codex: write %s: %w", path, err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return fmt.Errorf("codex: write %s: %w", path, err)
	}
	if err := os.Rename(name, path); err != nil {
		_ = os.Remove(name)
		return fmt.Errorf("codex: write %s: %w", path, err)
	}
	// The rename is durable only once the directory entry is.
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// ensureDir creates dir at 0700; this proxy's own auth directory is also
// tightened to 0700 when it already exists.
func (s *Store) ensureDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("codex: create %s: %w", dir, err)
	}
	if own := strings.TrimSpace(s.options.Dir); own != "" && sameFile(dir, own) {
		if err := os.Chmod(dir, 0o700); err != nil {
			return fmt.Errorf("codex: chmod %s: %w", dir, err)
		}
	}
	return nil
}

// lockPath is the lock shared by every proxy process using this auth dir.
func (s *Store) lockPath() string {
	dir := strings.TrimSpace(s.options.Dir)
	if dir == "" {
		dir = filepath.Dir(s.NativePath())
	}
	return filepath.Join(dir, lockFileName)
}

// lock takes the exclusive flock on lockPath, waiting at most lockWait or
// until ctx is done, and returns its release.
func (s *Store) lock(ctx context.Context) (func(), error) {
	path := s.lockPath()
	if err := s.ensureDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("codex: open lock %s: %w", path, err)
	}
	fd := int(file.Fd())
	deadline := time.Now().Add(lockWait)
	for attempt := 0; ; attempt++ {
		err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() {
				_ = syscall.Flock(fd, syscall.LOCK_UN)
				_ = file.Close()
			}, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) {
			_ = file.Close()
			return nil, fmt.Errorf("codex: lock %s: %w", path, err)
		}
		if attempt == 0 && lockBusy != nil {
			lockBusy()
		}
		if time.Now().After(deadline) {
			_ = file.Close()
			return nil, fmt.Errorf("codex: timed out waiting for the lock %s", path)
		}
		select {
		case <-ctx.Done():
			_ = file.Close()
			return nil, fmt.Errorf("codex: waiting for the lock %s: %w", path, ctx.Err())
		case <-time.After(lockPoll):
		}
	}
}

func stampOf(path string) fileStamp {
	info, err := os.Stat(path)
	if err != nil {
		return fileStamp{}
	}
	return fileStamp{size: info.Size(), modTime: info.ModTime()}
}

func expiryLabel(token *Token) string {
	if token == nil || token.ExpiresAt.IsZero() {
		return "unknown"
	}
	return token.ExpiresAt.Format(time.RFC3339)
}

// detectFormat picks the layout a credential file is written in.
func detectFormat(data []byte) format {
	if gjson.GetBytes(data, "tokens").IsObject() {
		return formatCodexCLI
	}
	return formatNative
}

func detectFormatOfFile(path string) format {
	data, err := os.ReadFile(path)
	if err != nil {
		return formatNative
	}
	return detectFormat(data)
}
