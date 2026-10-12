package codex

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// writeLocked persists the native token and installs it as the active
// credential, dropping the rejected-refresh latch. The caller holds the lock.
func (s *Store) writeLocked(token *Token, target string) error {
	if target == "" {
		return fmt.Errorf("codex: no credential file to write to")
	}
	if err := s.Check(); err != nil {
		return err
	}
	if token.LastRefresh.IsZero() {
		token.LastRefresh = time.Now()
	}

	token.Type = tokenType
	data, err := json.MarshalIndent(token, "", "  ")
	if err != nil {
		return err
	}
	if err := s.writeFileAtomic(target, append(data, '\n')); err != nil {
		return err
	}

	s.token, s.active, s.stamp, s.rejected = token, target, stampOf(target), nil
	s.noteLogin(true)
	return nil
}

// writeFileAtomic replaces path with data at mode 0600: a temporary file in
// the same directory, written and synced, set to 0600, then renamed over the
// old one, so a reader never sees half a file and a looser mode does not
// survive. A credential-file symlink is refused.
func (s *Store) writeFileAtomic(path string, data []byte) error {
	if err := refuseCredentialLink(path); err != nil {
		return err
	}
	path = writeTarget(path)
	dir := filepath.Dir(path)
	if err := s.ensureDir(dir); err != nil {
		return err
	}
	failed := func(err error) error { return fmt.Errorf("codex: write %s: %w", path, err) }

	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return failed(err)
	}
	tmpName := tmp.Name()
	if err := fillAndClose(tmp, data); err != nil {
		_ = os.Remove(tmpName)
		return failed(err)
	}
	if err := refuseCredentialLink(path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return failed(err)
	}
	// The rename is durable only once the directory entry is.
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// fillAndClose writes data to file, syncs it, sets it to 0600 and closes it,
// stopping at the first failure; the file is closed either way.
func fillAndClose(file *os.File, data []byte) error {
	_, err := file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	if err == nil {
		err = file.Chmod(0o600)
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return err
}

// ensureDir creates the credential directory at 0700, tightening an existing
// directory to the same mode.
func (s *Store) ensureDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("codex: create %s: %w", dir, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("codex: chmod %s: %w", dir, err)
	}
	return nil
}
