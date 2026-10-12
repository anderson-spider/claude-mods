package codex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// lockSuffix names the lock beside a credential file.
const lockSuffix = ".lock"

// lockWait bounds the wait for another process's refresh; it outlasts the
// OAuth client's own 30 s timeout.
const lockWait = 45 * time.Second

// lockPoll is how often a held lock is tried again.
const lockPoll = 25 * time.Millisecond

// lockPath is the lock beside the file this store writes, resolved the way
// the write resolves it.
func (s *Store) lockPath() string {
	return writeTarget(s.NativePath()) + lockSuffix
}

// lock serialises credential mutation across processes; waiting is bounded
// by lockWait and ctx. The caller releases the lock on every path.
func (s *Store) lock(ctx context.Context) (func(), error) {
	if err := s.Check(); err != nil {
		return nil, err
	}
	if err := s.ensureDir(s.options.Dir); err != nil {
		return nil, err
	}
	return s.lockFile(ctx, s.lockPath())
}

// lockFile takes the exclusive flock on path, creating it (and its directory,
// as ensureDir does) when needed, and returns its release.
func (s *Store) lockFile(ctx context.Context, path string) (func(), error) {
	if err := s.ensureDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("codex: open lock %s: %w", path, err)
	}
	if err := waitForFlock(ctx, file, path); err != nil {
		_ = file.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}

// waitForFlock tries the flock without blocking every lockPoll until it is
// taken, lockWait has passed or ctx is done.
func waitForFlock(ctx context.Context, file *os.File, path string) error {
	fd := int(file.Fd())
	deadline := time.Now().Add(lockWait)
	for {
		err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		switch {
		case err == nil:
			return nil
		case !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR):
			return fmt.Errorf("codex: lock %s: %w", path, err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("codex: timed out waiting for the lock %s", path)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("codex: waiting for the lock %s: %w", path, ctx.Err())
		case <-time.After(lockPoll):
		}
	}
}
