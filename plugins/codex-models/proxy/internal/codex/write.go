package codex

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// writeLocked persists token to target, keeping the fields of a Codex CLI
// layout file this proxy does not own, and installs it as the active
// credential (which also drops the rejected-refresh latch). The caller holds
// the file locks.
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

	s.token, s.active, s.stamp, s.rejected = token, target, stampOf(target.path), nil
	return nil
}

// writeFileAtomic replaces path with data at mode 0600: a temporary file in
// the same directory, written and synced, set to 0600, then renamed over the
// old one, so a reader never sees half a file and a looser mode does not
// survive. A symlink is written through to its target.
func (s *Store) writeFileAtomic(path string, data []byte) error {
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

// ensureDir creates dir at 0700, refusing CODEX_HOME and anything in it
// whatever Check was told; this proxy's own auth directory is also tightened
// to 0700 when it already exists.
func (s *Store) ensureDir(dir string) error {
	if insideCodexHome(dir) {
		return insideHomeError("the directory", dir)
	}
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
