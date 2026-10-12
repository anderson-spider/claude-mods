package codex

import (
	"fmt"
	"os"
	"path/filepath"
)

func refuseCredentialLink(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("codex: inspect credentials: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("codex: credential file must not be a symlink: %s", path)
	}
	return nil
}

// writeTarget resolves directory aliases, but never follows the credential.
// The directory is created before locking, so its canonical path exists then.
func writeTarget(path string) string {
	if dir, err := filepath.EvalSymlinks(filepath.Dir(path)); err == nil {
		path = filepath.Join(dir, filepath.Base(path))
	}
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return filepath.Clean(path)
}
