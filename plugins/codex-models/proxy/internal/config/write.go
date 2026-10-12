package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
)

// Save writes the whole configuration to Path, mode 0600, creating missing
// parent directories with mode 0700.
func (c *Config) Save() error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	return writePrivateFile(c.Path(), append(data, '\n'))
}

// writePrivateFile replaces path with data, mode 0600, so a reader sees the
// old file or the new one and never a partial write. The data goes to a
// temporary file beside path, which is synced, restricted, closed and renamed
// over path; the directory is then synced so the rename survives a crash.
// Renaming also leaves a fresh 0600 file where os.WriteFile would keep an
// existing file's looser mode. On failure the temporary file is removed and
// path is untouched.
func writePrivateFile(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("config: create %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".config-*.json")
	if err != nil {
		return fmt.Errorf("config: write %s: %w", path, err)
	}
	defer func() {
		if err != nil {
			_ = tmp.Close() // may already be closed; the first error is the one reported
			_ = os.Remove(tmp.Name())
			err = fmt.Errorf("config: write %s: %w", path, err)
		}
	}()

	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Chmod(0o600); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	syncDir(dir)
	return nil
}

// syncDir flushes a directory entry change. It is best effort: some systems
// cannot open or sync a directory, and the file itself is already written.
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = d.Sync()
	_ = d.Close()
}

// NewSecret returns 32 bytes from the system's secure random source, as 64
// lowercase hex characters.
func NewSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("config: generate a secret: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// FreeLoopbackAddr returns 127.0.0.1 with a port the system reports free
// right now, taken from its high ephemeral range.
func FreeLoopbackAddr() (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("config: pick a port: %w", err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		return "", fmt.Errorf("config: pick a port: %w", err)
	}
	return addr, nil
}
