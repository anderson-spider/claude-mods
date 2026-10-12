package codex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Two exclusive flocks serialise logins, refreshes and removals across proxy
// processes, always taken in this order and released in reverse:
//
//  1. legacyLockName in auth_dir, the one earlier releases took, so an older
//     binary on the same file and this one exclude each other (drop it once
//     no such binary can run);
//  2. lockSuffix beside the credential file as a write resolves it, so every
//     process on that file shares it whatever its auth_dir or link.
//
// Taking them in one order means two stores of this release never wait on
// each other crosswise. When both name one file it is taken once.

// lockSuffix names the lock beside a credential file.
const lockSuffix = ".lock"

// legacyLockName is the lock earlier releases took in auth_dir.
const legacyLockName = "codex.lock"

// lockWait bounds the wait for another process's refresh; it outlasts the
// OAuth client's own 30 s timeout.
const lockWait = 45 * time.Second

// lockPoll is how often a held lock is tried again.
const lockPoll = 25 * time.Millisecond

// lockBusy, when set (by tests), runs once each time lockFile finds the lock
// held.
var lockBusy func()

// lockPath is the lock beside the file this store writes, resolved the way
// the write resolves it.
func (s *Store) lockPath() string {
	return writeTarget(s.NativePath()) + lockSuffix
}

// legacyLockPath is where earlier releases locked: auth_dir, or the
// credential file's directory without one, joined as they joined it.
func (s *Store) legacyLockPath() string {
	dir := strings.TrimSpace(s.options.Dir)
	if dir == "" {
		dir = filepath.Dir(s.NativePath())
	}
	return filepath.Join(dir, legacyLockName)
}

// lock takes both locks in order and returns their release, in reverse. Each
// wait is bounded by lockWait and ctx; a failure on the second releases the
// first.
func (s *Store) lock(ctx context.Context) (func(), error) {
	legacy := s.legacyLockPath()
	releaseLegacy, err := s.lockFile(ctx, legacy)
	if err != nil {
		return nil, err
	}
	current := s.lockPath()
	if sameFile(legacy, current) {
		// An auth_file named "codex" makes them one file: a second flock on
		// it from another descriptor would wait on this one forever.
		return releaseLegacy, nil
	}
	releaseCurrent, err := s.lockFile(ctx, current)
	if err != nil {
		releaseLegacy()
		return nil, err
	}
	return func() {
		releaseCurrent()
		releaseLegacy()
	}, nil
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
	for first := true; ; first = false {
		err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		switch {
		case err == nil:
			return nil
		case !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR):
			return fmt.Errorf("codex: lock %s: %w", path, err)
		}
		if first && lockBusy != nil {
			lockBusy()
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
